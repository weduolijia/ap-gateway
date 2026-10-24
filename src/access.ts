import { AppError } from './config';
import type { Bindings } from './types';

export function authEnabled(env: Pick<Bindings, 'AUTH_ENABLED' | 'APP_ENV'>): boolean {
  return env.AUTH_ENABLED === 'true' || (env.APP_ENV !== 'local' && env.AUTH_ENABLED !== 'false');
}

function cookieName(url: string): string {
  return new URL(url).protocol === 'https:' ? '__Host-ap_session' : 'ap_session';
}

export function sessionToken(request: Request): string | null {
  const expected = cookieName(request.url);
  const matches = (request.headers.get('cookie') ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith(`${expected}=`));
  if (matches.length !== 1) return null;
  const token = matches[0].slice(expected.length + 1);
  return /^[a-f0-9]{64}$/.test(token) ? token : null;
}

export function sessionCookie(url: string, token: string, expiresAt?: string): string {
  const secure = new URL(url).protocol === 'https:' ? '; Secure' : '';
  const expiration = token && expiresAt ? `; Expires=${new Date(expiresAt).toUTCString()}; Max-Age=${Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000))}` : '; Max-Age=0';
  return `${cookieName(url)}=${token}; Path=/; HttpOnly; SameSite=Lax${secure}${expiration}`;
}

export async function sessionCsrf(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`ap-gateway-csrf:${token}`));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function requireCsrf(request: Request, token: string): Promise<void> {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
  const provided = request.headers.get('x-csrf-token') ?? '';
  const expected = await sessionCsrf(token);
  let difference = provided.length ^ expected.length;
  for (let index = 0; index < expected.length; index++) difference |= (provided.charCodeAt(index) || 0) ^ expected.charCodeAt(index);
  if (difference) throw new AppError('登录状态校验失败，请刷新页面后重试', 403, 'csrf_failed');
}

export function clientApiKey(request: Request): string | null {
  const authorization = request.headers.get('authorization');
  const values: string[] = [];
  if (authorization !== null) {
    const match = authorization.match(/^Bearer\s+(\S+)$/i);
    if (!match) throw new AppError('请使用有效的网关 API Key', 401, 'invalid_api_key');
    values.push(match[1]);
  }
  for (const header of ['x-api-key', 'x-goog-api-key']) {
    const value = request.headers.get(header);
    if (value !== null) values.push(value.trim());
  }
  if (!values.length) return null;
  if (values.some(value => value !== values[0]) || !/^sk-ap-[a-f0-9]{64}$/.test(values[0])) throw new AppError('网关 API Key 无效或请求中提供了冲突的密钥', 401, 'invalid_api_key');
  return values[0];
}

export function upstreamRequest(request: Request): Request {
  const headers = new Headers(request.headers);
  for (const name of ['authorization', 'x-api-key', 'x-goog-api-key', 'cookie', 'x-csrf-token']) headers.delete(name);
  return new Request(request.url, { method: request.method, headers, signal: request.signal });
}
