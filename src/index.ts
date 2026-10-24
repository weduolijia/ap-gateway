import { Hono } from 'hono';
import type { Bindings, KeyPolicy, Protocol } from './types';
import { AppError, FINGERPRINTS, PROTOCOLS, publicChannel, record, validateChannel, validateSettings } from './config';
import { HEADER_PRESETS } from './headers';
import { Store } from './store';
import { discoverModels, gateway, limitedJson } from './gateway';
import { AuthService } from './auth';
import { authEnabled, clientApiKey, requireCsrf, sessionCookie, sessionCsrf, sessionToken, upstreamRequest } from './access';
import { APP_VERSION, BUILD_DATE, VERSION_TAG } from './version';

const app = new Hono<{ Bindings: Bindings; Variables: { keyPolicy?: KeyPolicy } }>();
const localHost = (h: string) => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(h);
const versioned = (response: Response) => { response.headers.set('x-ap-version', VERSION_TAG); return response; };
app.use('*', async (c, next) => {
  const url = new URL(c.req.url);
  const path = c.req.path;
  if (authEnabled(c.env) && !localHost(url.hostname) && url.protocol !== 'https:') {
    if (['GET', 'HEAD'].includes(c.req.method)) {
      url.protocol = 'https:';
      return versioned(new Response(null, { status: 308, headers: { location: url.toString(), 'cache-control': 'no-store' } }));
    }
    throw new AppError('请通过 HTTPS 访问网关', 400, 'https_required');
  }
  if (!localHost(url.hostname) && !authEnabled(c.env) && c.env.ALLOW_UNAUTHENTICATED_PUBLIC !== 'true') return versioned(c.json({ error: { message: '测试版仅允许本地访问；尚未启用线上访问', type: 'local_only' } }, 403));
  const origin = c.req.header('origin');
  const documentNavigation = ['GET', 'HEAD'].includes(c.req.method)
    && ['/', '/index.html'].includes(path)
    && c.req.header('sec-fetch-mode') === 'navigate'
    && c.req.header('sec-fetch-dest') === 'document';
  const accessVary = 'Origin, Sec-Fetch-Site, Sec-Fetch-Mode, Sec-Fetch-Dest';
  if (!documentNavigation && ((origin && origin !== url.origin) || c.req.header('sec-fetch-site') === 'cross-site')) {
    return versioned(c.json({ error: { message: '不允许跨站访问网关', type: 'origin_not_allowed' } }, 403, { 'cache-control': 'no-store', vary: accessVary }));
  }
  if (c.req.method === 'OPTIONS') {
    return versioned(new Response(null, { status: 204, headers: { 'access-control-allow-origin': url.origin, 'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS', 'access-control-allow-headers': 'content-type,authorization,x-api-key,anthropic-version,anthropic-beta,x-goog-api-key,x-ap-channel,x-ap-protocol,x-ap-fingerprint,x-csrf-token', vary: accessVary } }));
  }
  const modelEndpoint = path.startsWith('/v1/') || path.startsWith('/v1beta/');
  const publicAuthEndpoint = ['/api/auth/session', '/api/auth/login'].includes(path);
  if (authEnabled(c.env) && (modelEndpoint || path.startsWith('/api/') && !publicAuthEndpoint)) {
    const auth = new AuthService(c.env.DB);
    const token = sessionToken(c.req.raw);
    const key = modelEndpoint ? clientApiKey(c.req.raw) : null;
    if (key) {
      const record = await auth.checkApiKey(key);
      if (!record) throw new AppError('网关 API Key 无效、已过期或已撤销', 401, 'invalid_api_key');
      c.set('keyPolicy', { channelId: record.channelId, models: record.models });
    } else {
      if (!token || !await auth.checkSession(token)) throw new AppError(modelEndpoint ? '请提供网关 API Key，或先登录管理页' : '请先登录管理页', 401, 'authentication_required');
      await requireCsrf(c.req.raw, token);
    }
  }
  await next();
  c.header('x-ap-version', VERSION_TAG);
  c.header('vary', [...new Set([...(c.res.headers.get('vary') ?? '').split(',').map(value => value.trim()).filter(Boolean), ...accessVary.split(', '), 'Cookie'])].join(', '));
  c.header('x-content-type-options', 'nosniff');
  c.header('referrer-policy', 'no-referrer');
  if (authEnabled(c.env) && !localHost(url.hostname) && url.protocol === 'https:') c.header('strict-transport-security', 'max-age=31536000');
  if (path.startsWith('/api/') || path.startsWith('/v1') || ['/healthz', '/readyz'].includes(path)) c.header('cache-control', 'no-store, no-transform');
  else c.header('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
});
app.onError((err, c) => {
  const e = err as Error & { status?: number; code?: string };
  const status = e.status && e.status >= 400 && e.status <= 599 ? e.status : 500;
  const message = status === 500 ? '网关内部错误，请确认数据库已初始化' : e.message;
  const headers = new Headers(err instanceof AppError ? err.headers : undefined);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  headers.set('x-ap-version', VERSION_TAG);
  const diagnostics = err instanceof AppError ? err.diagnostics : {};
  return new Response(JSON.stringify({ type: 'error', error: { type: e.code ?? (status === 500 ? 'internal_error' : 'invalid_request_error'), message, ...diagnostics } }), { status, headers });
});
async function bodyJson(req: Request): Promise<any> {
  const size = Number(req.headers.get('content-length') ?? 0);
  if (size > 2 * 1024 * 1024) throw new AppError('请求体最大为 2 MiB', 413, 'request_too_large');
  if (!req.headers.get('content-type')?.toLowerCase().includes('application/json')) throw new AppError('请使用 application/json 请求体', 415);
  try { return await limitedJson(new Response(req.body), 2 * 1024 * 1024); } catch (e) {
    if ((e as AppError).code === 'response_too_large') throw new AppError('请求体最大为 2 MiB', 413, 'request_too_large');
    throw new AppError('请求体不是有效 JSON');
  }
}
app.get('/healthz', c => c.json({ ok: true, version: APP_VERSION, build: BUILD_DATE, authMode: authEnabled(c.env) ? 'enabled' : 'disabled', environment: c.env.APP_ENV ?? 'local' }));
app.get('/readyz', async c => {
  try {
    await c.env.DB.prepare('SELECT 1 AS ok').first();
    return c.json({ ok: true, version: APP_VERSION, build: BUILD_DATE, database: 'ok' });
  } catch {
    return c.json({ ok: false, version: APP_VERSION, build: BUILD_DATE, database: 'unavailable' }, 503);
  }
});
app.get('/api/auth/session', async c => {
  if (!authEnabled(c.env)) return c.json({ authMode: 'disabled', authenticated: true });
  const token = sessionToken(c.req.raw);
  const session = token ? await new AuthService(c.env.DB).checkSession(token) : null;
  if (!session || !token) {
    c.header('set-cookie', sessionCookie(c.req.url, ''));
    return c.json({ authMode: 'enabled', authenticated: false });
  }
  return c.json({ authMode: 'enabled', authenticated: true, csrfToken: await sessionCsrf(token), expiresAt: session.expiresAt });
});
app.post('/api/auth/login', async c => {
  if (!authEnabled(c.env)) return c.json({ authMode: 'disabled', authenticated: true });
  const input = await bodyJson(c.req.raw);
  if (!record(input)) throw new AppError('登录请求无效');
  const auth = new AuthService(c.env.DB);
  const session = await auth.login(input.password, c.req.header('cf-connecting-ip') ?? 'local');
  const previousToken = sessionToken(c.req.raw);
  if (previousToken) await auth.logout(previousToken);
  c.header('set-cookie', sessionCookie(c.req.url, session.token, session.expiresAt));
  return c.json({ authMode: 'enabled', authenticated: true, csrfToken: await sessionCsrf(session.token), expiresAt: session.expiresAt });
});
app.post('/api/auth/logout', async c => {
  const token = sessionToken(c.req.raw);
  if (token && authEnabled(c.env)) await new AuthService(c.env.DB).logout(token);
  c.header('set-cookie', sessionCookie(c.req.url, ''));
  return c.json({ ok: true });
});
app.post('/api/auth/password', async c => {
  if (!authEnabled(c.env)) throw new AppError('当前环境未启用登录鉴权', 409, 'auth_disabled');
  const input = await bodyJson(c.req.raw);
  if (!record(input)) throw new AppError('密码修改请求无效');
  const session = await new AuthService(c.env.DB).changePassword(sessionToken(c.req.raw)!, input.currentPassword, input.newPassword, c.req.header('cf-connecting-ip') ?? 'local');
  c.header('set-cookie', sessionCookie(c.req.url, session.token, session.expiresAt));
  return c.json({ authenticated: true, csrfToken: await sessionCsrf(session.token), expiresAt: session.expiresAt });
});
async function keyBinding(env: Bindings, input: Record<string, unknown>): Promise<{ channelId: string | null; models: unknown }> {
  const channelId = typeof input.channelId === 'string' && input.channelId ? input.channelId : null;
  const models = input.models ?? null;
  if (channelId) {
    const channel = await new Store(env.DB).channel(channelId);
    if (!channel) throw new AppError('密钥绑定的渠道不存在', 400, 'invalid_key_channel');
    if (Array.isArray(models) && models.length) {
      const allowed = new Set([...channel.models, ...Object.keys(channel.modelMap)]);
      const invalid = models.filter(model => typeof model !== 'string' || (allowed.size > 0 && !allowed.has(model.trim())));
      if (invalid.length) throw new AppError(`模型不在该渠道的模型列表中：${invalid.slice(0, 3).join('、')}`, 400, 'invalid_key_models');
    }
  } else if (Array.isArray(models) && models.length) {
    throw new AppError('指定模型白名单前请先绑定渠道', 400, 'invalid_key_channel');
  }
  return { channelId, models };
}
app.get('/api/keys', async c => c.json({ keys: authEnabled(c.env) ? await new AuthService(c.env.DB).listApiKeys() : [] }));
app.post('/api/keys', async c => {
  if (!authEnabled(c.env)) throw new AppError('当前环境未启用网关鉴权', 409, 'auth_disabled');
  const input = await bodyJson(c.req.raw);
  if (!record(input)) throw new AppError('API Key 创建请求无效');
  const binding = await keyBinding(c.env, input);
  const created = await new AuthService(c.env.DB).createApiKey(input.name, input.expiresInDays, binding);
  const { key: secret, ...key } = created;
  return c.json({ key, secret }, 201);
});
app.put('/api/keys/:id', async c => {
  if (!authEnabled(c.env)) throw new AppError('当前环境未启用网关鉴权', 409, 'auth_disabled');
  const input = await bodyJson(c.req.raw);
  if (!record(input)) throw new AppError('密钥更新请求无效');
  const binding = await keyBinding(c.env, input);
  const key = await new AuthService(c.env.DB).updateApiKeyPolicy(c.req.param('id'), binding);
  return c.json({ key });
});
app.delete('/api/keys/:id', async c => {
  if (!authEnabled(c.env)) throw new AppError('当前环境未启用网关鉴权', 409, 'auth_disabled');
  await new AuthService(c.env.DB).revokeApiKey(c.req.param('id'));
  return c.json({ ok: true });
});
app.delete('/api/keys/:id/permanent', async c => {
  if (!authEnabled(c.env)) throw new AppError('当前环境未启用网关鉴权', 409, 'auth_disabled');
  await new AuthService(c.env.DB).purgeApiKey(c.req.param('id'));
  return c.json({ ok: true });
});
app.get('/api/status', async c => {
  const store = new Store(c.env.DB);
  const stats = c.req.query('stats') !== '0';
  const [statsResult, settings] = await Promise.all([stats ? store.stats() : Promise.resolve(null), store.settings()]);
  return c.json({ version: APP_VERSION, build: BUILD_DATE, authMode: authEnabled(c.env) ? 'enabled' : 'disabled', environment: c.env.APP_ENV ?? 'local', protocols: PROTOCOLS, fingerprints: FINGERPRINTS, headerPresets: HEADER_PRESETS, stats: statsResult, settings });
});
app.get('/api/channels', async c => c.json({ channels: (await new Store(c.env.DB).channels()).map(publicChannel) }));
app.post('/api/channels', async c => {
  const store = new Store(c.env.DB);
  const input = await bodyJson(c.req.raw);
  const settings = await store.settings();
  const channel = validateChannel(record(input) ? { fingerprint: settings.defaultFingerprint, ...input } : input, c.env);
  await store.saveChannel(channel);
  return c.json({ channel: publicChannel(channel) }, 201);
});
app.put('/api/channels/:id', async c => {
  const store = new Store(c.env.DB); const id = c.req.param('id');
  if (id === 'demo') throw new AppError('内置演示渠道只读');
  const existing = await store.channel(id); if (!existing) throw new AppError('渠道不存在', 404);
  const channel = validateChannel(await bodyJson(c.req.raw), c.env, existing);
  await store.saveChannel(channel, existing);
  if (!channel.enabled) {
    const settings = await store.settings();
    if (settings.defaultChannelId === channel.id) await store.saveSettings({ ...settings, defaultChannelId: 'demo' });
  }
  return c.json({ channel: publicChannel(channel) });
});
app.delete('/api/channels/:id', async c => {
  const store = new Store(c.env.DB); const id = c.req.param('id');
  if (id === 'demo') throw new AppError('内置演示渠道只读');
  if (!await store.channel(id)) throw new AppError('渠道不存在', 404);
  await store.deleteChannel(id);
  const settings = await store.settings();
  if (settings.defaultChannelId === id) { settings.defaultChannelId = 'demo'; await store.saveSettings(settings); }
  return c.json({ ok: true });
});
app.post('/api/channels/:id/probe', async c => {
  const store = new Store(c.env.DB);
  const channel = await store.channel(c.req.param('id'));
  if (!channel) throw new AppError('渠道不存在', 404);
  try { return c.json(await discoverModels(channel, store)); } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError((e as Error).name === 'AbortError' ? '模型发现超时' : '模型发现失败，请检查地址和网络', 502, 'probe_failed');
  }
});
app.get('/api/logs', async c => {
  const store = new Store(c.env.DB);
  const since = c.req.query('since');
  if (since === undefined) return c.json(await store.logs());
  if (!/^\d{1,15}$/.test(since)) throw new AppError('since 须为非负整数');
  return c.json(await store.logsSince(Number(since)));
});
app.delete('/api/logs', async c => { await new Store(c.env.DB).clearLogs(); return c.json({ ok: true }); });
app.get('/api/settings', async c => c.json({ settings: await new Store(c.env.DB).settings() }));
app.put('/api/settings', async c => {
  const store = new Store(c.env.DB);
  const settings = validateSettings(await bodyJson(c.req.raw), await store.settings());
  const defaultChannel = await store.channel(settings.defaultChannelId);
  if (!defaultChannel?.enabled) throw new AppError('默认渠道须存在且已启用');
  await store.saveSettings(settings);
  return c.json({ settings });
});
app.get('/api/export', async c => {
  const store = new Store(c.env.DB);
  return c.json({ version: 1, exportedAt: new Date().toISOString(), note: '此导出不包含上游 API 密钥。导入后需要重新填写。', channels: (await store.channels()).filter(ch => !ch.isDemo).map(publicChannel), settings: await store.settings() });
});
app.post('/api/import', async c => {
  const input = await bodyJson(c.req.raw);
  if (!record(input) || !Array.isArray(input.channels) || input.channels.length > 100) throw new AppError('导入文件须包含最多 100 个渠道');
  const store = new Store(c.env.DB);
  const channels = input.channels.filter((ch: any) => ch?.id !== 'demo' && !ch?.isDemo).map(ch => validateChannel(ch, c.env));
  const oldIds = input.channels.filter((ch: any) => ch?.id !== 'demo' && !ch?.isDemo).map((ch: any) => ch.id);
  let settings = await store.settings();
  if (input.settings) {
    if (!record(input.settings)) throw new AppError('导入设置无效');
    const idx = oldIds.indexOf(input.settings.defaultChannelId);
    settings = validateSettings({ ...input.settings, defaultChannelId: idx >= 0 ? channels[idx].id : 'demo' }, settings);
  }
  // Validate the complete file before issuing the atomic transaction.
  const queries = channels.map(ch => c.env.DB.prepare('INSERT INTO channels(id,config,created_at,updated_at) VALUES(?,?,?,?)').bind(ch.id, JSON.stringify(ch), ch.createdAt, ch.updatedAt));
  queries.push(c.env.DB.prepare('INSERT INTO settings(id,config) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET config=excluded.config').bind(JSON.stringify(settings)));
  await c.env.DB.batch(queries);
  return c.json({ imported: channels.length });
});
async function modelList(env: Bindings, policy?: KeyPolicy | null) {
  const channels = (await new Store(env.DB).channels()).filter(c => c.enabled);
  const visible = policy?.channelId ? channels.filter(c => c.id === policy.channelId) : channels;
  const ids = [...new Set(visible.flatMap(c => [...c.models, ...Object.keys(c.modelMap)]))];
  return policy?.models ? ids.filter(id => policy.models!.includes(id)) : ids;
}
app.get('/v1/models', async c => c.json({ object: 'list', data: (await modelList(c.env, c.get('keyPolicy'))).map(id => ({ id, object: 'model', created: 0, owned_by: 'ap-gateway' })) }));
app.get('/v1beta/models', async c => c.json({ models: (await modelList(c.env, c.get('keyPolicy'))).map(id => ({ name: `models/${id}`, displayName: id, supportedGenerationMethods: ['generateContent', 'streamGenerateContent'] })) }));
for (const [path, protocol] of [['/v1/chat/completions', 'openai'], ['/v1/responses', 'responses'], ['/v1/messages', 'anthropic']] as const) {
  app.post(path, async c => {
    const body = await bodyJson(c.req.raw);
    if (!record(body) || typeof body.model !== 'string' || !body.model || body.model.length > 200) throw new AppError('请求中需要有效的 model');
    if (body.stream !== undefined && typeof body.stream !== 'boolean') throw new AppError('stream 须为布尔值');
    if ((protocol === 'openai' || protocol === 'anthropic') && !Array.isArray(body.messages)) throw new AppError('messages 须为数组');
    if (protocol === 'responses' && body.input === undefined && !body.previous_response_id) throw new AppError('Responses 请求需要 input');
    return gateway(authEnabled(c.env) ? upstreamRequest(c.req.raw) : c.req.raw, c.env, c.executionCtx, protocol, body, body.model, body.stream === true, c.get('keyPolicy'));
  });
}
app.post('/v1beta/models/:action', async c => {
  const match = c.req.param('action').match(/^(.+):(streamGenerateContent|generateContent)$/);
  if (!match || match[1].length > 200) throw new AppError('Gemini 接口路径无效', 404);
  const body = await bodyJson(c.req.raw);
  if (!record(body) || !Array.isArray(body.contents)) throw new AppError('contents 须为数组');
  return gateway(authEnabled(c.env) ? upstreamRequest(c.req.raw) : c.req.raw, c.env, c.executionCtx, 'gemini', body, match[1], match[2] === 'streamGenerateContent', c.get('keyPolicy'));
});
app.all('/api/*', c => c.json({ error: { type: 'not_found', message: '接口不存在' } }, 404));
app.all('/v1/*', c => c.json({ error: { type: 'not_supported', message: '此测试版支持 models、chat/completions、responses 与 messages；当前接口未实现' } }, 501));
app.all('/v1beta/*', c => c.json({ error: { type: 'not_found', message: 'Gemini 接口不存在' } }, 404));
app.all('*', c => c.env.ASSETS.fetch(c.req.raw));
export default app;
