import type { Channel, Fingerprint, Protocol } from './types';
import { channelApiKeys } from './config';

// Header compatibility profiles. These do not emulate TLS or HTTP/2 handshakes.
export const HEADER_PRESETS: Record<Fingerprint, Record<string, string>> = {
  passthrough: {},
  codex: { 'user-agent': 'codex_cli_rs/0.0.0 (AP Gateway; compatibility)', originator: 'codex_cli_rs' },
  'claude-code': { 'user-agent': 'claude-cli/0.0.0 (external, cli; AP Gateway compatibility)', 'x-app': 'cli', 'anthropic-version': '2023-06-01', 'x-stainless-lang': 'js' },
};
const stripped = /^(host|content-length|cookie|set-cookie|connection|keep-alive|proxy-authenticate|proxy-authorization|te|trailer|transfer-encoding|upgrade|authorization|x-api-key|x-goog-api-key|x-csrf-token|origin|referer|accept-encoding|cf-.*|forwarded|x-forwarded-.*|x-real-ip|sec-.*|x-ap-.*)$/i;
export function upstreamHeaders(incoming: Headers, channel: Channel, protocol: Protocol, fingerprint: Fingerprint, stream: boolean, apiKey = channelApiKeys(channel)[0]): Headers {
  const out = new Headers();
  const connectionHeaders = new Set((incoming.get('connection') ?? '').split(',').map(s => s.trim().toLowerCase()));
  for (const [k, v] of incoming) if (!stripped.test(k) && !connectionHeaders.has(k.toLowerCase())) out.set(k, v);
  if (fingerprint !== 'passthrough') {
    for (const k of [...out.keys()]) if (/^(user-agent|originator|x-app|x-stainless-.*|anthropic-version|anthropic-beta|openai-beta|client-version|session_id|conversation_id)$/i.test(k)) out.delete(k);
  }
  for (const [k, v] of Object.entries(HEADER_PRESETS[fingerprint])) out.set(k, v);
  for (const [k, v] of Object.entries(channel.headers)) { if (v === '') out.delete(k); else out.set(k, v); }
  if (protocol !== 'anthropic') { out.delete('anthropic-version'); out.delete('anthropic-beta'); }
  if (protocol === 'anthropic' && !out.has('anthropic-version')) out.set('anthropic-version', '2023-06-01');
  const supplied = apiKey ?? incoming.get('x-api-key') ?? incoming.get('x-goog-api-key') ?? incoming.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (supplied) {
    if (protocol === 'anthropic') out.set('x-api-key', supplied);
    else if (protocol === 'gemini') out.set('x-goog-api-key', supplied);
    else out.set('authorization', `Bearer ${supplied}`);
  }
  out.set('content-type', 'application/json');
  out.set('accept', stream ? 'text/event-stream' : 'application/json');
  out.set('accept-encoding', 'identity');
  return out;
}
export function sanitizeUpstreamText(value: unknown, secrets: string[], maxLength = 400): string | undefined {
  if (typeof value !== 'string' || value.length > 65536) return undefined;
  const controls = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
  let safe = value.replace(controls, '');
  const credentials = [...new Set(secrets.filter(Boolean).flatMap(secret => [secret.replace(controls, ''), encodeURIComponent(secret)]))].filter(Boolean).sort((left, right) => right.length - left.length);
  for (const credential of credentials) safe = safe.split(credential).join('[REDACTED]');
  safe = safe
    .replace(/-----BEGIN [^-]+-----[\s\S]*?(?:-----END [^-]+-----|$)/g, '[REDACTED]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.~:%-]+/gi, '[REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]+|AIza[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, '[REDACTED]')
    .replace(/(\b(?:x[-_])?(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|authorization|proxy-authorization|password|passwd|secret|token|key)\b["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[REDACTED]')
    .replace(/\b(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[REDACTED]@')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED]')
    .replace(/\s+/g, ' ').trim();
  return safe ? safe.length > maxLength ? `${safe.slice(0, maxLength - 1)}…` : safe : undefined;
}
export function parseRetryAfter(value: string | null, now = Date.now()): { value: string; seconds: number } | undefined {
  if (!value || value.length > 128) return undefined;
  const normalized = value.trim();
  const maxSeconds = 365 * 24 * 60 * 60;
  if (/^\d{1,10}$/.test(normalized)) {
    const seconds = Number(normalized);
    return seconds <= maxSeconds ? { value: normalized, seconds } : undefined;
  }
  if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(normalized)) return undefined;
  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toUTCString() !== normalized) return undefined;
  const seconds = Math.max(0, Math.ceil((timestamp - now) / 1000));
  return Number.isFinite(seconds) && seconds <= maxSeconds ? { value: normalized, seconds } : undefined;
}
export function responseHeaders(upstream: Headers, stream: boolean, secrets: string[] = []): Headers {
  const h = new Headers();
  const allowed = ['request-id', 'x-request-id', 'openai-processing-ms', 'ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset'];
  for (const resource of ['requests', 'tokens']) for (const kind of ['limit', 'remaining', 'reset']) allowed.push(`x-ratelimit-${kind}-${resource}`);
  for (const resource of ['requests', 'tokens', 'input-tokens', 'output-tokens']) for (const kind of ['limit', 'remaining', 'reset']) allowed.push(`anthropic-ratelimit-${resource}-${kind}`);
  for (const name of allowed) {
    const value = upstream.get(name);
    if (!value || value.length > 256 || /[^\x20-\x7e]/.test(value)) continue;
    const safe = sanitizeUpstreamText(value, secrets, 256);
    if (safe === value) h.set(name, safe);
  }
  const retryAfter = parseRetryAfter(upstream.get('retry-after'));
  if (retryAfter && sanitizeUpstreamText(retryAfter.value, secrets, 128) === retryAfter.value) h.set('retry-after', retryAfter.value);
  h.set('content-type', stream ? 'text/event-stream; charset=utf-8' : 'application/json; charset=utf-8');
  h.set('cache-control', 'no-store, no-transform');
  h.set('x-content-type-options', 'nosniff');
  if (stream) h.set('x-accel-buffering', 'no');
  return h;
}
