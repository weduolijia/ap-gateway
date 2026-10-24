import { pbkdf2Sync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AuthService, hashPassword, verifyPassword } from '../src/auth';

const initialPassword = 'initial-password-42';
const replacementPassword = 'replacement-password-43';
const clientIp = '192.0.2.1';
const initialTime = Date.parse('2026-10-23T00:00:00Z');
const openDatabases: DatabaseSync[] = [];
let initialHash: string;

beforeAll(async () => { initialHash = await hashPassword(initialPassword); });
afterEach(() => { for (const database of openDatabases.splice(0)) database.close(); });

function setup(configured = true) {
  const sqlite = new DatabaseSync(':memory:');
  openDatabases.push(sqlite);
  sqlite.exec(readFileSync(new URL('../migrations/0002_auth.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0003_gateway_api_key_secret.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0004_gateway_api_key_binding.sql', import.meta.url), 'utf8'));
  if (configured) sqlite.prepare('INSERT INTO auth_admin(id,password_hash,session_version,updated_at) VALUES(1,?,1,?)').run(initialHash, initialTime);
  let now = initialTime;
  function prepare(sql: string) {
    let bindings: SQLInputValue[] = [];
    const execute = () => {
      const statement = sqlite.prepare(sql);
      const rows = statement.columns().length ? statement.all(...bindings) : (statement.run(...bindings), []);
      const changes = /^SELECT\b/i.test(sql) ? 0 : Number(sqlite.prepare('SELECT changes() AS count').get()!.count);
      return { success: true, results: rows, meta: { changes } };
    };
    const prepared = {
      sql,
      bind(...values: SQLInputValue[]) { bindings = values; return prepared; },
      async first() { return execute().results[0] ?? null; },
      async all() { return execute(); },
      async run() { return execute(); },
      execute,
    };
    return prepared;
  }
  const database = {
    prepare,
    async batch(statements: ReturnType<typeof prepare>[]) {
      sqlite.exec('BEGIN');
      try {
        const results = statements.map(statement => statement.execute());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
  const auth = new AuthService(database as unknown as D1Database, () => now);
  return { auth, sqlite, database, advance: (milliseconds: number) => { now += milliseconds; } };
}

describe('password hashing', () => {
  it('uses independently reproducible PBKDF2 SHA-256 with a fresh salt', async () => {
    const encoded = await hashPassword(initialPassword);
    const [algorithm, iterations, salt, derived] = encoded.split('$');
    expect(algorithm).toBe('pbkdf2-sha256');
    expect(iterations).toBe('100000');
    expect(salt).toMatch(/^[a-f0-9]{32}$/);
    expect(derived).toBe(pbkdf2Sync(initialPassword, Buffer.from(salt, 'hex'), 100000, 32, 'sha256').toString('hex'));
    expect(encoded).not.toBe(initialHash);
    expect(await verifyPassword(initialPassword, encoded)).toBe(true);
    expect(await verifyPassword('incorrect-password-42', encoded)).toBe(false);
  });
  it.each([null, undefined, 5, {}, '', 'short', 'x'.repeat(129)])('rejects invalid password input %#', async password => {
    expect(await verifyPassword(password, initialHash)).toBe(false);
    await expect(hashPassword(password as string)).rejects.toMatchObject({ code: 'invalid_password' });
  });
  it.each(['', 'pbkdf2-sha256$1$00$00', 'pbkdf2-sha256$999999999$' + 'a'.repeat(32) + '$' + 'a'.repeat(64), 'malformed'])('fails closed on malformed stored hashes %#', async encoded => {
    expect(await verifyPassword(initialPassword, encoded)).toBe(false);
  });
});

describe('admin authentication and sessions', () => {
  it('requires explicit administrator provisioning', async () => {
    const { auth, sqlite } = setup(false);
    expect(await auth.isConfigured()).toBe(false);
    await expect(auth.login(initialPassword, clientIp)).rejects.toMatchObject({ status: 503, code: 'authentication_unavailable' });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM auth_admin').get()!.count).toBe(0);
  });
  it('stores only a session hash and expires it after eight hours', async () => {
    const { auth, sqlite, advance } = setup();
    expect(await auth.isConfigured()).toBe(true);
    const session = await auth.login(initialPassword, clientIp);
    expect(session.token).toMatch(/^[a-f0-9]{64}$/);
    expect(await auth.checkSession(session.token)).toEqual({ expiresAt: '2026-10-23T08:00:00.000Z', version: 1 });
    const stored = JSON.stringify(sqlite.prepare('SELECT * FROM admin_sessions').all());
    expect(stored).not.toContain(session.token);
    expect(stored).not.toContain(initialPassword);
    advance(8 * 60 * 60 * 1000);
    expect(await auth.checkSession(session.token)).toBeNull();
  });
  it('logout revokes only the selected session and is idempotent', async () => {
    const { auth } = setup();
    const first = await auth.login(initialPassword, clientIp);
    const second = await auth.login(initialPassword, clientIp);
    await auth.logout(first.token);
    await auth.logout(first.token);
    await auth.logout(null);
    expect(await auth.checkSession(first.token)).toBeNull();
    expect(await auth.checkSession(second.token)).not.toBeNull();
  });
  it('invalidates every old session on a password change and issues a replacement', async () => {
    const { auth, sqlite } = setup();
    const first = await auth.login(initialPassword, clientIp);
    const second = await auth.login(initialPassword, clientIp);
    const replacement = await auth.changePassword(first.token, initialPassword, replacementPassword, clientIp);
    expect(await auth.checkSession(first.token)).toBeNull();
    expect(await auth.checkSession(second.token)).toBeNull();
    expect(await auth.checkSession(replacement.token)).toMatchObject({ version: 2 });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM admin_sessions').get()!.count).toBe(1);
    await expect(auth.login(initialPassword, clientIp)).rejects.toMatchObject({ status: 401 });
    expect((await auth.login(replacementPassword, clientIp)).token).toMatch(/^[a-f0-9]{64}$/);
    const stored = JSON.stringify(sqlite.prepare('SELECT * FROM auth_admin').all());
    expect(stored).not.toContain(initialPassword);
    expect(stored).not.toContain(replacementPassword);
  });
  it('does not change a password after failed reauthentication', async () => {
    const { auth, sqlite } = setup();
    const session = await auth.login(initialPassword, clientIp);
    await expect(auth.changePassword(session.token, 'wrong-old-password', replacementPassword, clientIp)).rejects.toMatchObject({ status: 401, code: 'invalid_credentials' });
    await expect(auth.changePassword(session.token, initialPassword, 'short', clientIp)).rejects.toMatchObject({ status: 400 });
    await expect(auth.changePassword(session.token, initialPassword, initialPassword, clientIp)).rejects.toMatchObject({ status: 400 });
    expect(await auth.checkSession(session.token)).toMatchObject({ version: 1 });
    expect(sqlite.prepare('SELECT password_hash FROM auth_admin').get()!.password_hash).toBe(initialHash);
  });
  it('allows only one concurrent password change from the same old version', async () => {
    const { auth, sqlite } = setup();
    const session = await auth.login(initialPassword, clientIp);
    const results = await Promise.allSettled([
      auth.changePassword(session.token, initialPassword, replacementPassword, clientIp),
      auth.changePassword(session.token, initialPassword, 'different-replacement-44', clientIp),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(sqlite.prepare('SELECT session_version FROM auth_admin').get()!.session_version).toBe(2);
    expect(await auth.checkSession(session.token)).toBeNull();
    const successful = results.find(result => result.status === 'fulfilled');
    if (successful?.status !== 'fulfilled') throw new Error('Expected a successful password change');
    expect(await auth.checkSession(successful.value.token)).toMatchObject({ version: 2 });
  });
  it('does not issue a session when the admin version changes during login', async () => {
    const { auth, sqlite, database } = setup();
    const originalBatch = database.batch;
    database.batch = async statements => {
      if (statements.some(statement => statement.sql.startsWith('INSERT INTO admin_sessions'))) sqlite.prepare('UPDATE auth_admin SET session_version=session_version+1 WHERE id=1').run();
      return originalBatch(statements);
    };
    await expect(auth.login(initialPassword, clientIp)).rejects.toMatchObject({ status: 401 });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM admin_sessions').get()!.count).toBe(0);
  });
});

describe('atomic login throttling', () => {
  it('admits only ten attempts even when twenty requests arrive together', async () => {
    const { auth, sqlite } = setup();
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => auth.login('incorrect-password-42', clientIp)));
    const errors = results.map(result => result.status === 'rejected' ? result.reason : null);
    expect(errors.filter(error => error?.status === 401)).toHaveLength(10);
    expect(errors.filter(error => error?.status === 429)).toHaveLength(10);
    for (const error of errors.filter(error => error?.status === 429)) expect(error.headers.get('Retry-After')).toBe('900');
    const stored = sqlite.prepare('SELECT * FROM login_attempts').get()!;
    expect(stored.attempts).toBe(11);
    expect(JSON.stringify(stored)).not.toContain(clientIp);
    expect(JSON.stringify(errors)).not.toContain('incorrect-password-42');
  });
  it('isolates different IPs and allows login after the fifteen-minute window', async () => {
    const { auth, advance } = setup();
    for (let attempt = 0; attempt < 10; attempt++) await expect(auth.login('', clientIp)).rejects.toMatchObject({ status: 401 });
    await expect(auth.login(initialPassword, clientIp)).rejects.toMatchObject({ status: 429 });
    expect((await auth.login(initialPassword, '192.0.2.2')).token).toBeTruthy();
    advance(15 * 60 * 1000);
    expect((await auth.login(initialPassword, clientIp)).token).toBeTruthy();
  });
  it('uses the same throttle for password reauthentication', async () => {
    const { auth } = setup();
    const session = await auth.login(initialPassword, clientIp);
    for (let attempt = 0; attempt < 9; attempt++) await expect(auth.changePassword(session.token, 'incorrect-password-42', replacementPassword, clientIp)).rejects.toMatchObject({ status: 401 });
    await expect(auth.changePassword(session.token, initialPassword, replacementPassword, clientIp)).rejects.toMatchObject({ status: 429 });
    expect(await auth.checkSession(session.token)).not.toBeNull();
  });
});

describe('gateway API keys', () => {
  it('keeps the full key for active keys so the owner can copy it later', async () => {
    const { auth, sqlite } = setup();
    const created = await auth.createApiKey('  CLI key  ', 30);
    expect(created.key).toMatch(/^sk-ap-[a-f0-9]{64}$/);
    expect(created).toMatchObject({ name: 'CLI key', createdAt: '2026-10-23T00:00:00.000Z', expiresAt: '2026-11-22T00:00:00.000Z', revokedAt: null, lastUsedAt: null });
    expect(created.secret).toBe(created.key);
    expect(created.preview).not.toBe(created.key);
    const listed = await auth.listApiKeys();
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty('key');
    expect(listed[0]).not.toHaveProperty('key_hash');
    expect(listed[0].secret).toBe(created.key);
    const stored = sqlite.prepare('SELECT key_hash,secret FROM gateway_api_keys').get() as { key_hash: string; secret: string };
    expect(stored.secret).toBe(created.key);
    expect(stored.key_hash).not.toBe(created.key);
    expect(stored.key_hash).toMatch(/^[a-f0-9]{64}$/);
  });
  it('stores an optional channel and model binding and updates it for active keys only', async () => {
    const { auth, sqlite } = setup();
    const bound = await auth.createApiKey('bound', null, { channelId: 'channel-alpha', models: ['gpt-4o', ' gpt-4o ', 'claude-3'] });
    expect(bound.channelId).toBe('channel-alpha');
    expect(bound.models).toEqual(['gpt-4o', 'claude-3']);
    const stored = sqlite.prepare('SELECT channel_id,models FROM gateway_api_keys').get() as { channel_id: string; models: string };
    expect(stored.channel_id).toBe('channel-alpha');
    expect(JSON.parse(stored.models)).toEqual(['gpt-4o', 'claude-3']);

    const plain = await auth.createApiKey('plain', null);
    expect(plain.channelId).toBeNull();
    expect(plain.models).toBeNull();

    const updated = await auth.updateApiKeyPolicy(bound.id, { channelId: null, models: [] });
    expect(updated.channelId).toBeNull();
    expect(updated.models).toBeNull();
    expect(updated.secret).toBe(bound.key);
    expect((await auth.listApiKeys()).find(key => key.id === bound.id)?.models).toBeNull();

    await auth.revokeApiKey(plain.id);
    await expect(auth.updateApiKeyPolicy(plain.id, { channelId: 'channel-beta', models: null })).rejects.toMatchObject({ code: 'api_key_inactive' });
    await expect(auth.updateApiKeyPolicy('00000000-0000-0000-0000-000000000000', { channelId: null, models: null })).rejects.toMatchObject({ code: 'api_key_not_found' });
    await expect(auth.updateApiKeyPolicy(bound.id, { models: [''] })).rejects.toMatchObject({ code: 'invalid_key_models' });
    await expect(auth.updateApiKeyPolicy(bound.id, { models: 'gpt-4o' })).rejects.toMatchObject({ code: 'invalid_key_models' });
  });
  it('keeps the binding visible on the request path so the gateway can enforce it', async () => {
    const { auth } = setup();
    const created = await auth.createApiKey('cli', null, { channelId: 'channel-alpha', models: ['gpt-4o'] });
    const checked = await auth.checkApiKey(created.key);
    expect(checked).toMatchObject({ id: created.id, channelId: 'channel-alpha', models: ['gpt-4o'], secret: null });
  });
  it('hides the stored key once it is revoked or expired, and for legacy rows without a copy', async () => {
    const { auth, advance, sqlite } = setup();
    const revoked = await auth.createApiKey('Revoked key');
    const expiring = await auth.createApiKey('Expiring key', 1);
    await auth.revokeApiKey(revoked.id);
    advance(2 * 86400000);
    const listed = await auth.listApiKeys();
    expect(listed.find(key => key.id === revoked.id)?.secret).toBeNull();
    expect(listed.find(key => key.id === expiring.id)?.secret).toBeNull();
    sqlite.prepare('INSERT INTO gateway_api_keys(id,name,key_hash,preview,created_at,expires_at,revoked_at,last_used_at,secret) VALUES(?,?,?,?,?,NULL,NULL,NULL,NULL)').run('11111111-1111-1111-1111-111111111111', 'Legacy key', 'a'.repeat(64), 'sk-ap-legacy…0000', initialTime);
    const legacy = (await auth.listApiKeys()).find(key => key.name === 'Legacy key');
    expect(legacy?.secret).toBeNull();
    expect(legacy?.preview).toBe('sk-ap-legacy…0000');
  });
  it('never returns the stored key on the request path', async () => {
    const { auth } = setup();
    const created = await auth.createApiKey('Runtime key');
    expect((await auth.checkApiKey(created.key))?.secret).toBeNull();
  });
  it('tracks use at most every five minutes and refuses expired keys', async () => {
    const { auth, advance } = setup();
    const created = await auth.createApiKey('Expiring key', 1);
    expect(await auth.checkApiKey(created.key)).toMatchObject({ id: created.id, lastUsedAt: '2026-10-23T00:00:00.000Z' });
    advance(60000);
    expect(await auth.checkApiKey(created.key)).toMatchObject({ lastUsedAt: '2026-10-23T00:00:00.000Z' });
    advance(4 * 60000);
    expect(await auth.checkApiKey(created.key)).toMatchObject({ lastUsedAt: '2026-10-23T00:05:00.000Z' });
    advance(24 * 60 * 60000 - 5 * 60000);
    expect(await auth.checkApiKey(created.key)).toBeNull();
  });
  it('revokes immediately and preserves the first revocation timestamp', async () => {
    const { auth, advance } = setup();
    const created = await auth.createApiKey('Revocable key');
    expect(created.expiresAt).toBeNull();
    expect(await auth.checkApiKey(created.key)).not.toBeNull();
    await auth.revokeApiKey(created.id);
    advance(1000);
    await auth.revokeApiKey(created.id);
    expect(await auth.checkApiKey(created.key)).toBeNull();
    expect((await auth.listApiKeys())[0].revokedAt).toBe('2026-10-23T00:00:00.000Z');
    await expect(auth.revokeApiKey(crypto.randomUUID())).rejects.toMatchObject({ status: 404 });
  });
  it('permanently deletes only revoked or expired keys and never touches active ones', async () => {
    const { auth, advance } = setup();
    const active = await auth.createApiKey('Active key');
    const revoked = await auth.createApiKey('Revoked key');
    await expect(auth.purgeApiKey(active.id)).rejects.toMatchObject({ status: 409, code: 'api_key_active' });
    await auth.revokeApiKey(revoked.id);
    await auth.purgeApiKey(revoked.id);
    const remaining = await auth.listApiKeys();
    expect(remaining.map(key => key.id)).toEqual([active.id]);
    expect(await auth.checkApiKey(revoked.key)).toBeNull();
    expect(await auth.checkApiKey(active.key)).not.toBeNull();
    const expiring = await auth.createApiKey('Expiring key', 1);
    advance(2 * 86400000);
    await auth.purgeApiKey(expiring.id);
    expect((await auth.listApiKeys()).map(key => key.id)).toEqual([active.id]);
  });
  it.each(['', 'not-a-uuid', 'SK-AP-1', '00000000-0000-0000-0000-00000000000z', '00000000-0000-0000-0000-000000000000'])('rejects unknown or malformed key ids on permanent delete %#', async id => {
    const { auth } = setup();
    await expect(auth.purgeApiKey(id)).rejects.toMatchObject({ status: 404, code: 'api_key_not_found' });
  });
  it('keeps API keys and administrative sessions separate', async () => {
    const { auth } = setup();
    const created = await auth.createApiKey('External client');
    const session = await auth.login(initialPassword, clientIp);
    expect(await auth.checkSession(created.key)).toBeNull();
    expect(await auth.checkApiKey(session.token)).toBeNull();
    await expect(auth.changePassword(created.key, initialPassword, replacementPassword, clientIp)).rejects.toMatchObject({ status: 401 });
    for (const invalid of [null, '', 'sk-ap-' + 'a'.repeat(64), 'sk-ap-' + 'a'.repeat(1000)]) expect(await auth.checkApiKey(invalid)).toBeNull();
  });
  it.each([null, undefined, {}, '', '   ', 'x'.repeat(81), 'name\nvalue'])('rejects invalid key names %#', async name => {
    await expect(setup().auth.createApiKey(name)).rejects.toMatchObject({ status: 400, code: 'invalid_key_name' });
  });
  it.each([0, -1, 366, 1.5, '30', {}, true])('rejects invalid key expiration %#', async expires => {
    await expect(setup().auth.createApiKey('Valid name', expires)).rejects.toMatchObject({ status: 400, code: 'invalid_key_expiry' });
  });
  it('enforces an atomic cap of one hundred active keys', async () => {
    const { auth } = setup();
    const results = await Promise.allSettled(Array.from({ length: 103 }, (_, index) => auth.createApiKey(`Key ${index}`)));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(100);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(3);
    const keys = await auth.listApiKeys();
    expect(keys).toHaveLength(100);
    await auth.revokeApiKey(keys[0].id);
    expect((await auth.createApiKey('After revocation')).key).toMatch(/^sk-ap-/);
  });
});
