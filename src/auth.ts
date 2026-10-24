import { AppError } from './config';
import { cacheDrop, cacheRead, cacheWrite } from './cache';

const PASSWORD_ITERATIONS = 100000;
const SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_ATTEMPT_LIMIT = 10;
const KEY_LAST_USED_INTERVAL_MS = 5 * 60 * 1000;
const KEY_CACHE_MS = 10_000;
const KEY_CACHE_PREFIX = 'key:';
const KEY_COLUMNS = 'id,name,preview,created_at,expires_at,revoked_at,last_used_at,secret,channel_id,models';
const KEY_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const encoder = new TextEncoder();

interface AdminRow { password_hash: string; session_version: number }
interface KeyRow {
  id: string;
  name: string;
  preview: string;
  created_at: number;
  expires_at: number | null;
  revoked_at: number | null;
  last_used_at: number | null;
  secret: string | null;
  channel_id: string | null;
  models: string | null;
}
export interface AdminSession { expiresAt: string; version: number }
export interface IssuedSession { token: string; expiresAt: string }
export interface PublicApiKey {
  id: string;
  name: string;
  preview: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  secret: string | null;
  channelId: string | null;
  models: string[] | null;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}
function randomSecret(): string { return hex(crypto.getRandomValues(new Uint8Array(32))); }
function unhex(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(value.match(/../g)!, byte => parseInt(byte, 16));
}
async function digest(value: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}
function validateNewPassword(password: unknown): asserts password is string {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) throw new AppError('密码须为 12–128 个字符', 400, 'invalid_password');
}
async function derivePassword(password: string, salt: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', iterations: PASSWORD_ITERATIONS, salt }, material, 256));
}
export async function hashPassword(password: string): Promise<string> {
  validateNewPassword(password);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2-sha256$${PASSWORD_ITERATIONS}$${hex(salt)}$${hex(await derivePassword(password, salt))}`;
}
export async function verifyPassword(password: unknown, encoded: string): Promise<boolean> {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128 || !/^pbkdf2-sha256\$100000\$[a-f0-9]{32}\$[a-f0-9]{64}$/.test(encoded)) return false;
  const [, , salt, expected] = encoded.split('$');
  const actual = await derivePassword(password, unhex(salt));
  const expectedBytes = unhex(expected);
  let difference = 0;
  for (let index = 0; index < actual.length; index++) difference |= actual[index] ^ expectedBytes[index];
  return difference === 0;
}
function validKeyId(id: unknown): id is string {
  return typeof id === 'string' && KEY_ID_PATTERN.test(id);
}
function publicKey(row: KeyRow, includeSecret = false): PublicApiKey {
  return {
    id: row.id, name: row.name, preview: row.preview, secret: includeSecret ? row.secret ?? null : null,
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: row.expires_at === null ? null : new Date(row.expires_at).toISOString(),
    revokedAt: row.revoked_at === null ? null : new Date(row.revoked_at).toISOString(),
    lastUsedAt: row.last_used_at === null ? null : new Date(row.last_used_at).toISOString(),
    channelId: row.channel_id ?? null,
    models: row.models === null ? null : (() => { try { const v = JSON.parse(row.models!); return Array.isArray(v) ? v.map(String) : null; } catch { return null; } })(),
  };
}
function encodeModels(models: string[] | null | undefined): string | null {
  return models && models.length ? JSON.stringify(models) : null;
}
function normalizeModels(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw new AppError('密钥模型白名单须为数组', 400, 'invalid_key_models');
  if (value.length > 500) throw new AppError('密钥模型白名单最多 500 项', 400, 'invalid_key_models');
  const models = value.map(item => typeof item === 'string' ? item.trim() : '');
  if (models.some(m => !m || m.length > 200)) throw new AppError('模型名称须为 1–200 个字符', 400, 'invalid_key_models');
  return [...new Set(models)];
}
function normalizeChannelId(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 64) throw new AppError('密钥绑定的渠道无效', 400, 'invalid_key_channel');
  return value;
}
function unauthorized(): AppError { return new AppError('请重新登录', 401, 'authentication_required'); }

export class AuthService {
  constructor(private db: D1Database, private clock: () => number = Date.now) {}

  async isConfigured(): Promise<boolean> {
    return !!await this.db.prepare('SELECT id FROM auth_admin WHERE id=1').first();
  }

  private async consumeLoginAttempt(clientIp: string): Promise<void> {
    const now = this.clock();
    const normalizedIp = typeof clientIp === 'string' && /^[a-f0-9:.]{1,64}$/i.test(clientIp) ? clientIp.toLowerCase() : 'unknown';
    const ipHash = await digest(`login:${normalizedIp}`);
    const results = await this.db.batch<{ attempts: number; window_start: number }>([
      this.db.prepare('DELETE FROM login_attempts WHERE window_start<=?').bind(now - LOGIN_WINDOW_MS),
      this.db.prepare('INSERT INTO login_attempts(ip_hash,window_start,attempts) VALUES(?,?,1) ON CONFLICT(ip_hash) DO UPDATE SET attempts=MIN(login_attempts.attempts+1,?) RETURNING attempts,window_start').bind(ipHash, now, LOGIN_ATTEMPT_LIMIT + 1),
    ]);
    const attempt = results[1].results[0];
    if (!attempt) throw new AppError('登录暂不可用，请稍后重试', 503, 'authentication_unavailable');
    if (attempt.attempts > LOGIN_ATTEMPT_LIMIT) {
      const retryAfter = Math.max(1, Math.ceil((attempt.window_start + LOGIN_WINDOW_MS - now) / 1000));
      throw new AppError('登录尝试过多，请稍后重试', 429, 'login_rate_limited', {}, new Headers({ 'Retry-After': String(retryAfter) }));
    }
  }

  async login(password: unknown, clientIp: string): Promise<IssuedSession> {
    await this.consumeLoginAttempt(clientIp);
    const admin = await this.db.prepare('SELECT password_hash,session_version FROM auth_admin WHERE id=1').first<AdminRow>();
    if (!admin) throw new AppError('管理员登录尚未配置', 503, 'authentication_unavailable');
    if (!await verifyPassword(password, admin.password_hash)) throw new AppError('密码错误', 401, 'invalid_credentials');
    const now = this.clock();
    const expiresAt = now + SESSION_LIFETIME_MS;
    const token = randomSecret();
    const results = await this.db.batch([
      this.db.prepare('DELETE FROM admin_sessions WHERE expires_at<=? OR session_version<>(SELECT session_version FROM auth_admin WHERE id=1)').bind(now),
      this.db.prepare('INSERT INTO admin_sessions(token_hash,session_version,created_at,expires_at) SELECT ?,session_version,?,? FROM auth_admin WHERE id=1 AND password_hash=? AND session_version=?').bind(await digest(token), now, expiresAt, admin.password_hash, admin.session_version),
    ]);
    if (results[1].meta.changes !== 1) throw new AppError('密码已更新，请重新登录', 401, 'invalid_credentials');
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }

  async checkSession(token: string | null): Promise<AdminSession | null> {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    const session = await this.db.prepare('SELECT sessions.expires_at,sessions.session_version FROM admin_sessions AS sessions JOIN auth_admin AS admin ON admin.id=1 AND admin.session_version=sessions.session_version WHERE sessions.token_hash=? AND sessions.expires_at>?').bind(await digest(token), this.clock()).first<{ expires_at: number; session_version: number }>();
    return session ? { expiresAt: new Date(session.expires_at).toISOString(), version: session.session_version } : null;
  }

  async logout(token: string | null): Promise<void> {
    if (token && /^[a-f0-9]{64}$/.test(token)) await this.db.prepare('DELETE FROM admin_sessions WHERE token_hash=?').bind(await digest(token)).run();
  }

  async changePassword(sessionToken: string, currentPassword: unknown, newPassword: unknown, clientIp: string): Promise<IssuedSession> {
    const session = await this.checkSession(sessionToken);
    if (!session) throw unauthorized();
    validateNewPassword(newPassword);
    await this.consumeLoginAttempt(clientIp);
    const admin = await this.db.prepare('SELECT password_hash,session_version FROM auth_admin WHERE id=1').first<AdminRow>();
    if (!admin || admin.session_version !== session.version) throw unauthorized();
    if (!await verifyPassword(currentPassword, admin.password_hash)) throw new AppError('当前密码错误', 401, 'invalid_credentials');
    if (currentPassword === newPassword) throw new AppError('新密码须与当前密码不同', 400, 'invalid_password');
    const passwordHash = await hashPassword(newPassword);
    const now = this.clock();
    const expiresAt = now + SESSION_LIFETIME_MS;
    const token = randomSecret();
    const results = await this.db.batch([
      this.db.prepare('UPDATE auth_admin SET password_hash=?,session_version=session_version+1,updated_at=? WHERE id=1 AND password_hash=? AND session_version=? AND EXISTS(SELECT 1 FROM admin_sessions WHERE token_hash=? AND expires_at>? AND session_version=?)').bind(passwordHash, now, admin.password_hash, session.version, await digest(sessionToken), now, session.version),
      this.db.prepare('DELETE FROM admin_sessions WHERE expires_at<=? OR session_version<>(SELECT session_version FROM auth_admin WHERE id=1)').bind(now),
      this.db.prepare('INSERT INTO admin_sessions(token_hash,session_version,created_at,expires_at) SELECT ?,session_version,?,? FROM auth_admin WHERE id=1 AND password_hash=? AND session_version=?').bind(await digest(token), now, expiresAt, passwordHash, session.version + 1),
    ]);
    if (results[0].meta.changes !== 1 || results[2].meta.changes !== 1) throw new AppError('登录状态已更新，请重新登录', 409, 'password_change_conflict');
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }

  async listApiKeys(): Promise<PublicApiKey[]> {
    const now = this.clock();
    const rows = await this.db.prepare(`SELECT ${KEY_COLUMNS} FROM gateway_api_keys ORDER BY CASE WHEN revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?) THEN 0 ELSE 1 END,created_at DESC LIMIT 500`).bind(now).all<KeyRow>();
    return rows.results.map(row => publicKey(row, row.revoked_at === null && (row.expires_at === null || row.expires_at > now)));
  }

  async createApiKey(name: unknown, expiresInDays?: unknown, policy?: { channelId?: unknown; models?: unknown }): Promise<PublicApiKey & { key: string }> {
    if (typeof name !== 'string' || !name.trim() || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) throw new AppError('密钥名称须为 1–80 个可显示字符', 400, 'invalid_key_name');
    if (expiresInDays !== undefined && expiresInDays !== null && (typeof expiresInDays !== 'number' || !Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 365)) throw new AppError('密钥有效期须为 1–365 天或不设置', 400, 'invalid_key_expiry');
    const now = this.clock();
    const expiresAt = typeof expiresInDays === 'number' ? now + expiresInDays * 86400000 : null;
    const key = `sk-ap-${randomSecret()}`;
    const channelId = normalizeChannelId(policy?.channelId);
    const models = encodeModels(normalizeModels(policy?.models));
    const row = await this.db.prepare(`INSERT INTO gateway_api_keys(id,name,key_hash,preview,created_at,expires_at,secret,channel_id,models) SELECT ?,?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM gateway_api_keys WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?))<100 RETURNING ${KEY_COLUMNS}`).bind(crypto.randomUUID(), name.trim(), await digest(key), `${key.slice(0, 12)}…${key.slice(-4)}`, now, expiresAt, key, channelId, models, now).first<KeyRow>();
    if (!row) throw new AppError('最多保留 100 个有效密钥，请先撤销不再使用的密钥', 409, 'api_key_limit');
    cacheDrop(this.db, KEY_CACHE_PREFIX);
    return { ...publicKey(row, true), key };
  }

  async updateApiKeyPolicy(id: string, policy: { channelId?: unknown; models?: unknown }): Promise<PublicApiKey> {
    if (!validKeyId(id)) throw new AppError('密钥不存在', 404, 'api_key_not_found');
    const channelId = normalizeChannelId(policy?.channelId);
    const models = encodeModels(normalizeModels(policy?.models));
    const now = this.clock();
    const row = await this.db.prepare('UPDATE gateway_api_keys SET channel_id=?,models=? WHERE id=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?) RETURNING ' + KEY_COLUMNS).bind(channelId, models, id, now).first<KeyRow>();
    cacheDrop(this.db, KEY_CACHE_PREFIX);
    if (row) return publicKey(row, true);
    const existing = await this.db.prepare('SELECT revoked_at FROM gateway_api_keys WHERE id=?').bind(id).first<{ revoked_at: number | null }>();
    if (!existing) throw new AppError('密钥不存在', 404, 'api_key_not_found');
    throw new AppError('已撤销或已过期的密钥不能再修改绑定', 409, 'api_key_inactive');
  }

  async revokeApiKey(id: string): Promise<void> {
    if (!validKeyId(id)) throw new AppError('密钥不存在', 404, 'api_key_not_found');
    const row = await this.db.prepare('UPDATE gateway_api_keys SET revoked_at=COALESCE(revoked_at,?) WHERE id=? RETURNING id').bind(this.clock(), id).first();
    if (!row) throw new AppError('密钥不存在', 404, 'api_key_not_found');
    cacheDrop(this.db, KEY_CACHE_PREFIX);
  }

  async purgeApiKey(id: string): Promise<void> {
    if (!validKeyId(id)) throw new AppError('密钥不存在', 404, 'api_key_not_found');
    const now = this.clock();
    const removed = await this.db.prepare('DELETE FROM gateway_api_keys WHERE id=? AND (revoked_at IS NOT NULL OR (expires_at IS NOT NULL AND expires_at<=?)) RETURNING id').bind(id, now).first();
    cacheDrop(this.db, KEY_CACHE_PREFIX);
    if (removed) return;
    const existing = await this.db.prepare('SELECT id FROM gateway_api_keys WHERE id=?').bind(id).first();
    if (!existing) throw new AppError('密钥不存在', 404, 'api_key_not_found');
    throw new AppError('该密钥仍可使用，请先撤销后再删除', 409, 'api_key_active');
  }

  async checkApiKey(key: string | null): Promise<PublicApiKey | null> {
    if (!key || !/^sk-ap-[a-f0-9]{64}$/.test(key)) return null;
    const now = this.clock();
    const cacheKey = `${KEY_CACHE_PREFIX}${await digest(key)}`;
    const cached = cacheRead<KeyRow>(this.db, cacheKey, now);
    if (cached) {
      if (cached.revoked_at !== null || (cached.expires_at !== null && cached.expires_at <= now)) { cacheDrop(this.db, cacheKey); return null; }
      return publicKey(cached);
    }
    const row = await this.db.prepare(`SELECT ${KEY_COLUMNS} FROM gateway_api_keys WHERE key_hash=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)`).bind(await digest(key), now).first<KeyRow>();
    if (!row) return null;
    if (row.last_used_at === null || row.last_used_at <= now - KEY_LAST_USED_INTERVAL_MS) {
      const updated = await this.db.prepare('UPDATE gateway_api_keys SET last_used_at=? WHERE id=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?) AND (last_used_at IS NULL OR last_used_at<=?)').bind(now, row.id, now, now - KEY_LAST_USED_INTERVAL_MS).run();
      if (updated.meta.changes === 1) row.last_used_at = now;
    }
    cacheWrite(this.db, cacheKey, row, KEY_CACHE_MS, now);
    return publicKey(row);
  }
}
