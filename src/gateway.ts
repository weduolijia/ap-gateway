import type { Bindings, Channel, ChannelKeySelection, Fingerprint, KeyPolicy, Protocol, RequestLog, UpstreamDiagnostics } from './types';
import { AppError, channelApiKeys, FINGERPRINTS, PROTOCOLS, record } from './config';
import { upstreamHeaders, responseHeaders, parseRetryAfter, sanitizeUpstreamText } from './headers';
import { convertRequest, convertResponse, convertStream } from './protocols';
import { Store } from './store';
import { demoResponse } from './demo';
import { monitorStream } from './streaming';

export function upstreamUrl(baseUrl: string, protocol: Protocol, model?: string, stream = false, models = false): string {
  const url = new URL(baseUrl);
  let root = url.pathname.replace(/\/+$/, '');
  root = root.replace(/\/v1(?:beta)?$/, '');
  if (protocol === 'gemini') url.pathname = `${root}/v1beta/models${models ? '' : `/${encodeURIComponent(model!)}:${stream ? 'streamGenerateContent' : 'generateContent'}`}`;
  else url.pathname = `${root}/v1/${models ? 'models' : protocol === 'anthropic' ? 'messages' : protocol === 'responses' ? 'responses' : 'chat/completions'}`;
  if (protocol === 'gemini' && stream && !models) url.searchParams.set('alt', 'sse');
  return url.toString();
}
export function candidateProtocols(channel: Channel, incoming: Protocol, override: string | null, cached?: Protocol): Protocol[] {
  if (channel.protocol !== 'auto') return [channel.protocol];
  if (override && override !== 'auto' && !PROTOCOLS.includes(override as Protocol)) throw new AppError('x-ap-protocol 的值无效');
  const choice = override ?? 'auto';
  if (choice !== 'auto') return [choice as Protocol];
  const allowed = channel.protocols;
  return [...new Set([...(cached && allowed.includes(cached) ? [cached] : []), ...(allowed.includes(incoming) ? [incoming] : []), ...allowed])];
}
export function isProtocolMismatch(status: number, error: any): boolean {
  if ([405, 415, 501].includes(status)) return true;
  if (status !== 404) return false;
  const code = String(error?.error?.code ?? error?.error?.type ?? '');
  const message = String(error?.error?.message ?? error?.message ?? '');
  if (/model|deployment/i.test(`${code} ${message}`)) return false;
  return /^(endpoint_not_found|route_not_found|unsupported_endpoint|unknown_endpoint|not_found)$/i.test(code)
    || /(?:unknown|unsupported|unrecognized|invalid)\s+(?:url|route|endpoint)|(?:route|endpoint)\s+(?:not found|does not exist)|cannot post\s+\//i.test(message);
}
export function channelServesModel(channel: Channel, model: string): boolean {
  const allowed = [...channel.models, ...Object.keys(channel.modelMap)];
  return allowed.length === 0 || allowed.includes(model);
}
export function selectChannel(channels: Channel[], channelId: string | null, defaultId: string, model: string, policy?: KeyPolicy | null): Channel {
  if (policy?.channelId) {
    const bound = channels.find(c => c.id === policy.channelId);
    if (!bound || !bound.enabled) throw new AppError('此密钥绑定的渠道不存在或已停用，请联系管理员', 403, 'channel_unavailable');
    if (channelId && channelId !== bound.id) throw new AppError('此密钥已绑定到其他渠道，不能指定 x-ap-channel', 403, 'channel_not_allowed');
    if (!channelServesModel(bound, model)) throw new AppError(`此密钥不允许使用模型「${model}」`, 403, 'model_not_allowed');
    return bound;
  }
  if (channelId) {
    const c = channels.find(c => c.id === channelId);
    if (!c || !c.enabled) throw new AppError('指定渠道不存在或已停用', 404, 'channel_not_found');
    return c;
  }
  const matching = channels.filter(c => c.enabled && (c.models.includes(model) || Object.hasOwn(c.modelMap, model))).sort((a, b) => b.priority - a.priority);
  if (matching.length) return matching.find(c => c.id === defaultId) ?? matching[0];
  const fallback = channels.find(c => c.id === defaultId && c.enabled && !c.isDemo) ?? channels.filter(c => c.enabled && !c.isDemo && !c.models.length).sort((a, b) => b.priority - a.priority)[0];
  if (!fallback) throw new AppError('没有可用的真实渠道。请添加渠道或使用演示模型 ap-demo', 404, 'model_not_found');
  return fallback;
}
const decoder = new TextDecoder();
export async function limitedJson(response: Response, maxBytes = 8 * 1024 * 1024): Promise<any> {
  if (!response.body) throw new AppError('上游返回空响应', 502, 'empty_upstream');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const r = await reader.read(); if (r.done) break;
      bytes += r.value.byteLength;
      if (bytes > maxBytes) { await reader.cancel(); throw new AppError('响应超过大小限制', 502, 'response_too_large'); }
      chunks.push(r.value);
    }
  } finally { reader.releaseLock(); }
  let buf = chunks[0] ?? new Uint8Array(0);
  if (chunks.length > 1) {
    buf = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { buf.set(chunk, offset); offset += chunk.byteLength; }
  }
  try { return JSON.parse(decoder.decode(buf)); } catch { throw new AppError('响应不是有效 JSON', 502, 'invalid_upstream_response'); }
}
function diagnosticSecrets(channels: Channel[], incoming = new Headers()): string[] {
  return [...channels.flatMap(channel => [...channelApiKeys(channel), channel.apiKey ?? '']), ...['authorization', 'x-api-key', 'x-goog-api-key'].flatMap(name => {
    const value = incoming.get(name) ?? '';
    return [value, value.replace(/^(?:Bearer|Basic)\s+/i, '')];
  })].filter(Boolean);
}
function upstreamFailure(response: Response, body: unknown, secrets: string[], fallbackMessage: string, status = response.status, code = 'upstream_error'): AppError {
  const headers = responseHeaders(response.headers, false, secrets);
  const diagnostics: UpstreamDiagnostics = {};
  const error = record(body) ? record(body.error) ? body.error : body : {};
  for (const value of [error.code, error.type, error.status]) {
    const safe = sanitizeUpstreamText(value, secrets, 100);
    if (safe && /^[A-Za-z0-9_.:-]{1,100}$/.test(safe)) { diagnostics.upstreamCode = safe; break; }
  }
  diagnostics.upstreamMessage = sanitizeUpstreamText(error.message, secrets);
  if (response.status === 429) diagnostics.retryAfterSeconds = parseRetryAfter(headers.get('retry-after'))?.seconds;
  const reason = diagnostics.upstreamMessage ?? diagnostics.upstreamCode;
  const message = response.status === 429
    ? `上游限流（HTTP 429）${reason ? `：${reason}` : '；上游未提供具体原因'}`
    : reason ? `上游 ${status}：${reason}` : fallbackMessage;
  return new AppError(message, status, code, diagnostics, headers);
}
function gatewayHeaders(headers: Headers, context: Pick<RequestLog, 'id' | 'channelId' | 'incomingProtocol' | 'upstreamProtocol' | 'fingerprint' | 'attempts' | 'keyIndex' | 'conversionWarnings'>): Headers {
  headers.set('x-ap-request-id', context.id);
  headers.set('x-ap-channel', context.channelId);
  headers.set('x-ap-protocol', context.upstreamProtocol);
  headers.set('x-ap-incoming-protocol', context.incomingProtocol);
  headers.set('x-ap-fingerprint', context.fingerprint);
  headers.set('x-ap-attempts', String(context.attempts));
  headers.set('x-ap-forwarded', context.attempts > 0 ? 'true' : 'false');
  if (context.conversionWarnings?.length) headers.set('x-ap-conversion-warnings', JSON.stringify(context.conversionWarnings).replace(/[^\x20-\x7E]/g, '').slice(0, 4096));
  if (context.keyIndex !== null) headers.set('x-ap-key-index', String(context.keyIndex));
  return headers;
}
export async function gateway(request: Request, env: Bindings, ctx: { waitUntil(promise: Promise<unknown>): void }, incoming: Protocol, body: any, model: string, stream: boolean, policy?: KeyPolicy | null): Promise<Response> {
  const started = Date.now();
  const store = new Store(env.DB);
  const [channels, settings] = await Promise.all([store.channels(), store.settings()]);
  const secrets = diagnosticSecrets(channels, request.headers);
  if (policy?.models && !policy.models.includes(model)) throw new AppError(`此密钥不允许使用模型「${model}」`, 403, 'model_not_allowed');
  const channel = selectChannel(channels, request.headers.get('x-ap-channel'), settings.defaultChannelId, model, policy);
  const upstreamModel = channel.modelMap[model] ?? model;
  const fp = request.headers.get('x-ap-fingerprint') ?? channel.fingerprint ?? settings.defaultFingerprint;
  if (!FINGERPRINTS.includes(fp as Fingerprint)) throw new AppError('x-ap-fingerprint 的值无效');
  const fingerprint = fp as Fingerprint;
  const log: RequestLog = { id: crypto.randomUUID(), time: new Date(started).toISOString(), channelId: channel.id, channelName: channel.name, model, incomingProtocol: incoming, upstreamProtocol: channel.protocol === 'auto' ? incoming : channel.protocol, fingerprint, stream, status: 200, durationMs: 0, firstByteMs: null, outcome: 'ok', attempts: 0, keyIndex: null, keyCount: channelApiKeys(channel).length };
  let logged = false;
  const saveLog = () => {
    if (logged) return; logged = true;
    log.durationMs = Date.now() - started;
    ctx.waitUntil(store.log(log, settings.logRetention).catch(() => {}));
  };
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  request.signal.addEventListener('abort', onAbort, { once: true });
  if (request.signal.aborted) controller.abort();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const cleanup = () => { if (deadline) clearTimeout(deadline); request.signal.removeEventListener('abort', onAbort); };
  try {
    const cacheKey = `${channel.id}:${incoming}:${model}`;
    const override = request.headers.get('x-ap-protocol');
    const cached = channel.isDemo ? undefined : await store.cachedProtocol(cacheKey);
    const candidates = candidateProtocols(channel, incoming, override, cached);
    log.upstreamProtocol = candidates[0] ?? log.upstreamProtocol;
    const selection = await store.selectApiKey(channel);
    if (selection.apiKey) secrets.push(selection.apiKey);
    log.keyIndex = selection.keyIndex;
    log.keyCount = selection.keyCount;
    let response: Response | undefined;
    let selected: Protocol = incoming;
    let lastConversionError: unknown;
    for (const protocol of candidates) {
      let payload: any;
      const conversionWarnings: string[] = [];
      if (log.attempts === 0) log.upstreamProtocol = protocol;
      try {
        payload = convertRequest(body, incoming, protocol, upstreamModel, stream, conversionWarnings);
        if (protocol !== 'gemini') payload = { ...payload, model: upstreamModel, stream };
      } catch (e) {
        lastConversionError = e;
        if (candidates.length === 1) throw e;
        continue;
      }
      selected = protocol;
      log.upstreamProtocol = protocol;
      log.conversionWarnings = [...new Set(conversionWarnings)].map(warning => sanitizeUpstreamText(warning, secrets, 200)).filter((warning): warning is string => !!warning).slice(0, 20);
      log.attempts++;
      deadline = setTimeout(() => controller.abort(), channel.timeoutMs);
      response = channel.isDemo ? demoResponse(protocol, payload, upstreamModel, stream, env.APP_ENV) : await fetch(upstreamUrl(channel.baseUrl, protocol, upstreamModel, stream), { method: 'POST', headers: upstreamHeaders(request.headers, channel, protocol, fingerprint, stream, selection.apiKey), body: JSON.stringify(payload), redirect: 'manual', signal: controller.signal });
      if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new AppError('上游返回重定向；请填写最终网关基础地址', 502, 'upstream_redirect'); }
      if (response.ok) break;
      const status = response.status;
      const err = await limitedJson(response, 65536).catch(() => ({}));
      clearTimeout(deadline);
      const mismatch = isProtocolMismatch(status, err);
      if (!mismatch || protocol === candidates.at(-1)) throw upstreamFailure(response, err, secrets, `上游 ${status}；请检查渠道协议、模型及上游密钥`, status >= 400 && status <= 599 ? status : 502);
      response = undefined;
    }
    if (!response?.ok) throw lastConversionError ?? new AppError('所选渠道没有兼容的协议', 502, 'no_compatible_protocol');
    const headers = gatewayHeaders(responseHeaders(response.headers, stream, secrets), log);
    if (stream) {
      clearTimeout(deadline);
      if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) { await response.body?.cancel(); throw new AppError('上游没有返回 SSE 流；网关不会将完整 JSON 伪装成流', 502, 'upstream_not_streaming'); }
      const translated = convertStream(response.body, selected, incoming, model);
      const observed = monitorStream(translated, incoming, { started, heartbeatMs: settings.heartbeatMs, timeoutMs: settings.streamTimeoutMs, abort: () => controller.abort(), sanitize: message => sanitizeUpstreamText(message, secrets, 600) ?? '上游返回错误事件', complete: result => {
        cleanup();
        const outcome = request.signal.aborted ? 'cancelled' : result.outcome;
        log.firstByteMs = result.firstByteMs; log.outcome = outcome; log.error = outcome === 'cancelled' ? 'client_cancelled' : result.error;
        if (result.errorMessage) log.errorMessage = sanitizeUpstreamText(result.errorMessage, secrets, 600);
        log.status = outcome === 'ok' ? 200 : outcome === 'cancelled' ? 499 : 502;
        if (!channel.isDemo && outcome === 'ok') ctx.waitUntil(store.cacheProtocol(cacheKey, selected).catch(() => {}));
        saveLog();
      } });
      return new Response(observed, { headers });
    }
    const json = await limitedJson(response);
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw new AppError('上游没有返回有效的响应对象', 502, 'invalid_upstream_response');
    if (json.error) {
      const reason = sanitizeUpstreamText(record(json.error) ? json.error.message : json.error, secrets);
      throw new AppError(reason ? `上游在成功状态中返回了错误对象：${reason}` : '上游在成功状态中返回了错误对象', 502, 'upstream_error', reason ? { upstreamMessage: reason } : {});
    }
    const output = convertResponse(json, selected, incoming, model);
    cleanup();
    if (!channel.isDemo) ctx.waitUntil(store.cacheProtocol(cacheKey, selected).catch(() => {}));
    log.firstByteMs = Date.now() - started;
    saveLog();
    return new Response(JSON.stringify(output), { headers });
  } catch (error) {
    cleanup(); controller.abort();
    const e = error as Error & { status?: number; code?: string };
    if (request.signal.aborted) { log.status = 499; log.outcome = 'cancelled'; log.error = 'client_cancelled'; }
    else { log.status = e.status ?? (e.name === 'AbortError' ? 504 : 502); log.outcome = 'error'; log.error = e.code ?? (e.name === 'AbortError' ? 'upstream_timeout' : 'gateway_error'); }
    if (error instanceof AppError) Object.assign(log, error.diagnostics);
    if (e.code === 'unsupported_protocol_conversion') log.errorMessage = sanitizeUpstreamText(e.message, secrets, 600);
    else if (log.upstreamMessage) log.errorMessage = log.upstreamMessage;
    saveLog();
    const failure = e.code === 'unsupported_protocol_conversion'
      ? new AppError(log.errorMessage ?? '请求包含当前上游协议无法转换的字段', log.status, e.code)
      : e.status ? e : new AppError(e.name === 'AbortError' ? '上游请求超时' : '无法完成上游请求，请检查基础地址与网络', log.status, log.error);
    if (failure instanceof AppError) gatewayHeaders(failure.headers, log);
    throw failure;
  }
}

export async function discoverModels(channel: Channel, store: Store, selection?: ChannelKeySelection): Promise<{ models: string[]; protocols: Protocol[]; message: string; keyIndex: number | null; keyCount: number }> {
  if (channel.isDemo) return { models: channel.models, protocols: channel.protocols, message: '内置演示器可用，无外部请求', keyIndex: null, keyCount: 0 };
  const selected = selection ?? await store.selectApiKey(channel);
  const secrets = diagnosticSecrets([channel]);
  if (selected.apiKey) secrets.push(selected.apiKey);
  const context = { id: crypto.randomUUID(), channelId: channel.id, incomingProtocol: channel.protocol === 'auto' ? channel.protocols[0] : channel.protocol, upstreamProtocol: channel.protocols[0], fingerprint: channel.fingerprint, attempts: 0, keyIndex: selected.keyIndex };
  const choices = channel.protocol === 'auto' ? channel.protocols : [channel.protocol];
  const tried = new Set<string>();
  for (const protocol of choices) {
    const url = upstreamUrl(channel.baseUrl, protocol, undefined, false, true);
    if (tried.has(url)) continue; tried.add(url);
    const abort = new AbortController(); const timeout = setTimeout(() => abort.abort(), Math.min(channel.timeoutMs, 20000));
    try {
      context.upstreamProtocol = protocol;
      context.attempts++;
      const res = await fetch(url, { headers: upstreamHeaders(new Headers(), channel, protocol, channel.fingerprint, false, selected.apiKey), redirect: 'manual', signal: abort.signal });
      if (!res.ok) {
        if ([404, 405].includes(res.status)) { await res.body?.cancel(); continue; }
        const body = res.status === 429 ? await limitedJson(res, 65536).catch(() => ({})) : undefined;
        if (res.status !== 429) await res.body?.cancel();
        throw upstreamFailure(res, body, secrets, `模型发现返回 HTTP ${res.status}，请检查上游密钥或地址`, res.status === 429 ? 429 : 502, 'probe_failed');
      }
      const json = await limitedJson(res);
      const values = json.data ?? json.models;
      if (!Array.isArray(values)) throw new AppError('上游没有返回可识别的模型列表', 502, 'probe_invalid');
      const models = [...new Set<string>(values.map((m: any) => String(m.id ?? m.name ?? '').replace(/^models\//, '')).filter(Boolean))];
      return { models, protocols: channel.protocols, message: `发现 ${models.length} 个模型。此操作仅查询模型列表；推理协议将在真实请求时协商。`, keyIndex: selected.keyIndex, keyCount: selected.keyCount };
    } catch (error) {
      if (error instanceof AppError) gatewayHeaders(error.headers, context);
      throw error;
    } finally { clearTimeout(timeout); }
  }
  throw new AppError('上游没有提供模型列表接口，可以在渠道中手动填写模型', 422, 'models_not_available');
}
