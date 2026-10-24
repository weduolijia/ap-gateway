import type { Bindings, Channel, Fingerprint, Protocol, Settings, UpstreamDiagnostics } from './types';

export const PROTOCOLS: Protocol[] = ['openai', 'responses', 'anthropic', 'gemini'];
export const FINGERPRINTS: Fingerprint[] = ['passthrough', 'codex', 'claude-code'];
export const DEFAULT_SETTINGS: Settings = { defaultChannelId: 'demo', defaultFingerprint: 'passthrough', heartbeatMs: 10000, streamTimeoutMs: 120000, logRetention: 500 };
export const DEMO_CHANNEL: Channel = { id: 'demo', name: '内置演示', baseUrl: 'demo://local', enabled: true, protocol: 'auto', protocols: [...PROTOCOLS], fingerprint: 'passthrough', headers: {}, models: ['ap-demo'], modelMap: {}, timeoutMs: 30000, priority: -999, isDemo: true };
export class AppError extends Error {
  constructor(message: string, public status = 400, public code = 'invalid_request', public diagnostics: UpstreamDiagnostics = {}, public headers = new Headers()) { super(message); }
}
export function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function integer(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new AppError(`数值必须是 ${min}–${max} 之间的整数`);
  return value;
}
export function validateBaseUrl(value: string, env: Pick<Bindings, 'APP_ENV' | 'ALLOW_LOCAL_UPSTREAM'>): string {
  let u: URL;
  try { u = new URL(value); } catch { throw new AppError('网关地址不是有效 URL'); }
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new AppError('网关地址须为 HTTP(S) 地址，不能包含用户名、密码、查询参数或片段');
  const localAllowed = env.APP_ENV === 'local' && env.ALLOW_LOCAL_UPSTREAM === 'true';
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const local = h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || !h.includes('.') || /^(0|10|127)\./.test(h) || /^169\.254\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h) || h.includes(':');
  if (!localAllowed && (local || u.protocol !== 'https:')) throw new AppError('当前环境只接受公共 HTTPS 上游；本地地址仅用于本地开发');
  if (/\/(chat\/completions|responses|messages)$/.test(u.pathname) || /:(streamGenerateContent|generateContent)$/.test(u.pathname)) throw new AppError('请填写基础地址（可带 /v1），不要填写具体模型接口路径');
  return u.toString().replace(/\/+$/, '');
}
const forbiddenCustom = /^(authorization|proxy-authorization|x-api-key|x-goog-api-key|host|content-length|cookie|set-cookie|connection|upgrade|transfer-encoding|te|trailer|keep-alive|cf-.*|forwarded|x-forwarded-.*|x-ap-.*)$/i;
export function validateHeaders(input: unknown): Record<string, string> {
  if (!record(input) || Object.keys(input).length > 32) throw new AppError('请求头须为最多 32 项的 JSON 对象');
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(input)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || forbiddenCustom.test(key)) throw new AppError(`不允许配置 ${key}；鉴权请使用上游密钥字段`);
    if (typeof val !== 'string' || /[\r\n\0]|[^\x00-\xFF]/.test(val) || val.length > 4096) throw new AppError(`请求头 ${key} 的值无效（请使用 HTTP 支持的字符）`);
    out[key.toLowerCase()] = val;
  }
  return out;
}
export function channelApiKeys(channel?: Channel): string[] {
  return channel?.apiKeys ?? (channel?.apiKey ? [channel.apiKey] : []);
}
function validateApiKeys(input: Record<string, unknown>, existing?: Channel): string[] {
  if (input.apiKeys !== undefined && input.apiKey !== undefined) throw new AppError('apiKey 与 apiKeys 不能同时填写');
  let values: unknown;
  if (input.apiKeys !== undefined) values = input.apiKeys === null ? [] : input.apiKeys;
  else if (input.apiKey === null) values = [];
  else if (input.apiKey === '' || input.apiKey === undefined) values = channelApiKeys(existing);
  else values = [input.apiKey];
  if (!Array.isArray(values) || values.length > 100) throw new AppError('上游密钥须为最多 100 项的数组');
  if (values.some(value => typeof value !== 'string' || !value.trim() || /[\r\n\0]|[^\x00-\xFF]/.test(value) || value.length > 8192)) throw new AppError('每个上游密钥须为有效的非空 HTTP 字符串，最多 8192 个字符');
  return [...new Set(values.map(value => value.trim()))];
}
export function validateChannel(input: unknown, env: Pick<Bindings, 'APP_ENV' | 'ALLOW_LOCAL_UPSTREAM'>, existing?: Channel): Channel {
  if (!record(input)) throw new AppError('渠道配置须为 JSON 对象');
  const c = { ...existing, ...input };
  if (typeof c.name !== 'string' || !c.name.trim() || c.name.length > 80) throw new AppError('渠道名称须为 1–80 个字符');
  if (typeof c.baseUrl !== 'string') throw new AppError('请填写上游基础地址');
  const protocol = c.protocol ?? 'auto';
  if (protocol !== 'auto' && !PROTOCOLS.includes(protocol as Protocol)) throw new AppError('未知的上游协议');
  const protocols = c.protocols ?? PROTOCOLS;
  if (!Array.isArray(protocols) || !protocols.length || protocols.some(p => !PROTOCOLS.includes(p))) throw new AppError('请选择至少一种支持的协议');
  const fingerprint = c.fingerprint ?? 'passthrough';
  if (!FINGERPRINTS.includes(fingerprint as Fingerprint)) throw new AppError('未知的指纹预设');
  const models = c.models ?? [];
  if (!Array.isArray(models) || models.length > 1000 || models.some(m => typeof m !== 'string' || !m.trim() || m.length > 200)) throw new AppError('模型列表无效');
  const modelMap = c.modelMap ?? {};
  if (!record(modelMap) || Object.keys(modelMap).length > 1000 || Object.entries(modelMap).some(([k, v]) => !k || typeof v !== 'string' || !v || k.length > 200 || v.length > 200)) throw new AppError('模型映射须为名称到上游模型名称的 JSON 对象');
  const apiKeys = validateApiKeys(input, existing);
  if (c.enabled !== undefined && typeof c.enabled !== 'boolean') throw new AppError('enabled 须为布尔值');
  return { id: existing?.id ?? crypto.randomUUID(), name: c.name.trim(), baseUrl: validateBaseUrl(c.baseUrl, env), apiKeys, enabled: c.enabled !== false, protocol: protocol as Channel['protocol'], protocols: [...new Set(protocols)], fingerprint: fingerprint as Fingerprint, headers: validateHeaders(c.headers ?? {}), models: [...new Set(models.map(m => m.trim()))], modelMap: modelMap as Record<string, string>, timeoutMs: integer(c.timeoutMs, 60000, 1000, 300000), priority: integer(c.priority, 0, -100, 100), createdAt: existing?.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString() };
}
export function publicChannel(c: Channel): Omit<Channel, 'apiKey' | 'apiKeys'> & { hasApiKey: boolean; keyCount: number } {
  const { apiKey, apiKeys, ...rest } = c;
  const keyCount = channelApiKeys(c).length;
  return { ...rest, hasApiKey: keyCount > 0, keyCount };
}
export function validateSettings(input: unknown, current: Settings): Settings {
  if (!record(input)) throw new AppError('设置须为 JSON 对象');
  const s = { ...current, ...input };
  if (typeof s.defaultChannelId !== 'string' || !s.defaultChannelId) throw new AppError('请选择默认渠道');
  if (!FINGERPRINTS.includes(s.defaultFingerprint as Fingerprint)) throw new AppError('未知的默认指纹');
  return { defaultChannelId: s.defaultChannelId, defaultFingerprint: s.defaultFingerprint as Fingerprint, heartbeatMs: integer(s.heartbeatMs, 10000, 1000, 30000), streamTimeoutMs: integer(s.streamTimeoutMs, 120000, 5000, 600000), logRetention: integer(s.logRetention, 500, 20, 5000) };
}
