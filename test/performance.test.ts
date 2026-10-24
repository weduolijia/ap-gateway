import { describe, expect, it, vi } from 'vitest';
import { AuthService } from '../src/auth';
import { Store } from '../src/store';
import { gateway } from '../src/gateway';
import { DEFAULT_SETTINGS, validateChannel } from '../src/config';
import type { Bindings, Channel } from '../src/types';

const environment = { APP_ENV: 'local', ALLOW_LOCAL_UPSTREAM: 'true' };

function channel(input: Record<string, unknown> = {}): Channel {
  return validateChannel({ name: 'Perf', baseUrl: 'http://127.0.0.1:9999', apiKeys: ['first-secret', 'second-secret'], models: ['perf-model'], ...input }, environment);
}

describe('configuration cache', () => {
  it('reuses the channel list until it is invalidated', async () => {
    const saved = channel();
    const all = vi.fn().mockResolvedValue({ results: [{ config: JSON.stringify(saved) }] });
    const prepare = vi.fn(() => ({ all, bind: () => ({ run: async () => ({ meta: { changes: 1 } }) }) }));
    const batch = vi.fn(async () => [{ meta: { changes: 1 } }, { meta: { changes: 0 } }, { meta: { changes: 0 } }]);
    const store = new Store({ prepare, batch } as unknown as D1Database);
    const first = await store.channels();
    expect(await store.channels()).toBe(first);
    expect(all).toHaveBeenCalledTimes(1);
    await store.saveChannel({ ...saved, name: 'Renamed' }, saved);
    const reloaded = await store.channels();
    expect(all).toHaveBeenCalledTimes(2);
    expect(reloaded).not.toBe(first);
  });

  it('reuses settings until they are saved', async () => {
    let stored: unknown = { ...DEFAULT_SETTINGS, heartbeatMs: 1234 };
    const first = vi.fn(async () => ({ config: JSON.stringify(stored) }));
    const prepare = vi.fn(() => ({ first, bind: () => ({ run: async () => ({ meta: { changes: 1 } }) }) }));
    const store = new Store({ prepare } as unknown as D1Database);
    expect((await store.settings()).heartbeatMs).toBe(1234);
    expect((await store.settings()).heartbeatMs).toBe(1234);
    expect(first).toHaveBeenCalledTimes(1);
    stored = { ...DEFAULT_SETTINGS, heartbeatMs: 4321 };
    await store.saveSettings({ ...DEFAULT_SETTINGS, heartbeatMs: 4321 });
    expect((await store.settings()).heartbeatMs).toBe(4321);
    expect(first).toHaveBeenCalledTimes(2);
  });

  it('skips the protocol write when the negotiated protocol did not change', async () => {
    const run = vi.fn().mockResolvedValue({ meta: { changes: 1 } });
    const first = vi.fn().mockResolvedValue({ protocol: 'openai' });
    const prepare = vi.fn((sql: string) => sql.startsWith('SELECT') ? { bind: () => ({ first }) } : { bind: () => ({ run }) });
    const store = new Store({ prepare } as unknown as D1Database);
    expect(await store.cachedProtocol('c:openai:m')).toBe('openai');
    expect(await store.cachedProtocol('c:openai:m')).toBe('openai');
    expect(first).toHaveBeenCalledTimes(1);
    await store.cacheProtocol('c:openai:m', 'openai');
    expect(run).not.toHaveBeenCalled();
    await store.cacheProtocol('c:openai:m', 'gemini');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('rotates keys in memory instead of writing on every request', async () => {
    const first = vi.fn().mockResolvedValue({ key_index: 0 });
    const prepare = vi.fn(() => ({ bind: () => ({ first }) }));
    const store = new Store({ prepare } as unknown as D1Database);
    const pool = channel();
    expect(await store.selectApiKey(pool)).toMatchObject({ apiKey: 'first-secret', keyIndex: 1 });
    expect(await store.selectApiKey(pool)).toMatchObject({ apiKey: 'second-secret', keyIndex: 2 });
    expect(await store.selectApiKey(pool)).toMatchObject({ apiKey: 'first-secret', keyIndex: 1 });
    expect(prepare).toHaveBeenCalledTimes(1);
  });
});

describe('gateway key cache', () => {
  const row = { id: 'k1', name: 'key', preview: 'sk-ap-preview', created_at: 0, expires_at: null, revoked_at: null, last_used_at: Date.now(), secret: null };
  it('reuses a verified key for the cache window and drops it on revoke', async () => {
    const first = vi.fn().mockResolvedValue(row);
    const prepare = vi.fn((sql: string) => {
      if (sql.startsWith('SELECT')) return { bind: () => ({ first }) };
      if (sql.startsWith('UPDATE gateway_api_keys')) return { bind: () => ({ first: async () => ({ id: 'k1' }), run: async () => ({ meta: { changes: 1 } }) }) };
      return { bind: () => ({ run: async () => ({ meta: { changes: 1 } }) }) };
    });
    const auth = new AuthService({ prepare } as unknown as D1Database);
    const key = `sk-ap-${'a'.repeat(64)}`;
    expect(await auth.checkApiKey(key)).toMatchObject({ id: 'k1' });
    expect(await auth.checkApiKey(key)).toMatchObject({ id: 'k1' });
    expect(first).toHaveBeenCalledTimes(1);
    await auth.revokeApiKey('11111111-1111-1111-1111-111111111111');
    expect(await auth.checkApiKey(key)).toMatchObject({ id: 'k1' });
    expect(first).toHaveBeenCalledTimes(2);
  });
});

describe('statements per gateway request', () => {
  it('serves a warm request with the configuration already cached', async () => {
    const saved = channel();
    let statements = 0;
    const prepare = vi.fn((sql: string) => {
      statements++;
      if (sql.startsWith('SELECT config FROM channels')) return { all: async () => ({ results: [{ config: JSON.stringify({ ...saved, id: saved.id }) }] }) };
      if (sql.startsWith('SELECT config FROM settings')) return { first: async () => null };
      if (sql.startsWith('SELECT protocol FROM protocol_cache')) return { bind: () => ({ first: async () => null }) };
      if (sql.startsWith('INSERT INTO channel_key_rotation')) return { bind: () => ({ first: async () => ({ key_index: 0 }) }) };
      if (sql.startsWith('INSERT INTO protocol_cache')) return { bind: () => ({ run: async () => ({ meta: { changes: 1 } }) }) };
      if (sql.startsWith('INSERT INTO request_logs')) return { bind: () => ({ run: async () => ({ meta: { changes: 1 } }) }) };
      if (sql.startsWith('DELETE FROM request_logs')) return { bind: () => ({ run: async () => ({ meta: { changes: 0 } }) }) };
      throw new Error('unexpected statement: ' + sql);
    });
    const db = { prepare, batch: async (list: Array<{ run(): Promise<unknown> }>) => Promise.all(list.map(statement => statement.run())) };
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ id: 'chatcmpl', model: 'perf-model', choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }] })));
    const run = async () => {
      const pending: Promise<unknown>[] = [];
      const response = await gateway(new Request('http://localhost/v1/chat/completions', { headers: { authorization: 'Bearer client' } }), { DB: db, APP_ENV: 'local', ALLOW_LOCAL_UPSTREAM: 'true' } as unknown as Bindings, { waitUntil(promise) { pending.push(promise); } }, 'openai', { model: 'perf-model', messages: [{ role: 'user', content: 'hi' }] }, 'perf-model', false);
      await Promise.all(pending);
      return response;
    };
    expect((await run()).status).toBe(200);
    const cold = statements;
    statements = 0;
    for (let index = 0; index < 5; index++) expect((await run()).status).toBe(200);
    const warm = statements / 5;
    expect(cold).toBeGreaterThanOrEqual(6);
    expect(warm).toBeLessThanOrEqual(3);
    vi.unstubAllGlobals();
  });
});
