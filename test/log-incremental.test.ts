import { describe, expect, it, vi } from 'vitest';
import { Store } from '../src/store';
import app from '../src/index';
import { AuthService } from '../src/auth';
import { sessionCsrf } from '../src/access';
import type { Bindings } from '../src/types';

const logRow = (id: string, time = '2026-10-24T00:00:00.000Z') => JSON.stringify({ id, time, status: 200, durationMs: 10, outcome: 'ok' });

function storeWith(rows: string[], cursor: number | null = 42) {
  const all = vi.fn(async () => ({ results: rows.map(config => ({ config })) }));
  const first = vi.fn(async () => (cursor === null ? null : { cursor }));
  const prepare = vi.fn((sql: string) => {
    if (sql.includes('MAX(rowid)')) return { first };
    if (sql.includes('WHERE rowid')) return { bind: () => ({ all }) };
    return { all, bind: () => ({ all }) };
  });
  return { store: new Store({ prepare } as unknown as D1Database), prepare, all, first };
}

describe('incremental request logs', () => {
  it('returns the newest page together with a cursor', async () => {
    const { store, first } = storeWith([logRow('a'), logRow('b')]);
    const result = await store.logs();
    expect(result.cursor).toBe(42);
    expect(result.logs.map(log => log.id)).toEqual(['a', 'b']);
    expect(first).toHaveBeenCalledOnce();
  });
  it('returns only rows newer than the cursor', async () => {
    const { store, all } = storeWith([logRow('c'), logRow('b')]);
    const result = await store.logsSince(41);
    expect(result).toMatchObject({ cursor: 42, reset: false });
    expect(result.logs.map(log => log.id)).toEqual(['c', 'b']);
    expect(all).toHaveBeenCalledOnce();
  });
  it('reports no change when nothing is newer', async () => {
    const { store } = storeWith([]);
    expect(await store.logsSince(42)).toEqual({ logs: [], cursor: 42, reset: false });
  });
  it('falls back to a full reload when the table was cleared', async () => {
    const { store } = storeWith([], 3);
    const reload = vi.spyOn(store, 'logs').mockResolvedValue({ logs: [{ id: 'x' } as never], cursor: 3 });
    const result = await store.logsSince(99);
    expect(result.reset).toBe(true);
    expect(result.logs.map(log => log.id)).toEqual(['x']);
    expect(reload).toHaveBeenCalledOnce();
  });
  it('forces a full reload when a single page cannot cover the gap', async () => {
    const many = Array.from({ length: 500 }, (_, index) => logRow(`n${index}`));
    const { store } = storeWith(many);
    const reload = vi.spyOn(store, 'logs').mockResolvedValue({ logs: [], cursor: 42 });
    expect((await store.logsSince(0)).reset).toBe(true);
    expect(reload).toHaveBeenCalledOnce();
  });
});

describe('log and status query parameters', () => {
  const base = 'https://gateway.example.com';
  const token = 'a'.repeat(64);
  const environment = { DB: {}, AUTH_ENABLED: 'true', APP_ENV: 'cloud-test' } as Bindings;
  const request = (path: string) => app.fetch(new Request(base + path, { headers: { cookie: `__Host-ap_session=${token}` } }), environment);

  it('rejects a malformed log cursor, including negative and oversized values', async () => {
    vi.spyOn(AuthService.prototype, 'checkSession').mockResolvedValue({ expiresAt: new Date(Date.now() + 10000).toISOString(), version: 1 });
    for (const query of ['since=abc', 'since=-1', 'since=1.5', 'since=1234567890123456', 'since=']) {
      const response = await request(`/api/logs?${query}`);
      expect(response.status).toBe(400);
      expect((await response.json()).error.message).toContain('since');
    }
  });
  it('accepts a numeric cursor and returns the incremental page', async () => {
    vi.spyOn(AuthService.prototype, 'checkSession').mockResolvedValue({ expiresAt: new Date(Date.now() + 10000).toISOString(), version: 1 });
    vi.spyOn(Store.prototype, 'logsSince').mockResolvedValue({ logs: [], cursor: 7, reset: false });
    const response = await request('/api/logs?since=7');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ logs: [], cursor: 7, reset: false });
  });
  it('omits statistics when the dashboard asks for configuration only', async () => {
    vi.spyOn(AuthService.prototype, 'checkSession').mockResolvedValue({ expiresAt: new Date(Date.now() + 10000).toISOString(), version: 1 });
    const stats = vi.spyOn(Store.prototype, 'stats').mockResolvedValue({ total: 0, successRate: 0, avgLatencyMs: 0, activeChannels: 0 });
    vi.spyOn(Store.prototype, 'settings').mockResolvedValue({ defaultChannelId: 'demo', defaultFingerprint: 'passthrough', heartbeatMs: 10000, streamTimeoutMs: 120000, logRetention: 500 });
    const response = await request('/api/status?stats=0');
    expect(response.status).toBe(200);
    expect((await response.json()).stats).toBeNull();
    expect(stats).not.toHaveBeenCalled();
    const full = await request('/api/status');
    expect(full.status).toBe(200);
    expect(stats).toHaveBeenCalledOnce();
  });
  it('keeps CSRF protection for log clearing', async () => {
    vi.spyOn(AuthService.prototype, 'checkSession').mockResolvedValue({ expiresAt: new Date(Date.now() + 10000).toISOString(), version: 1 });
    const response = await app.fetch(new Request(`${base}/api/logs`, { method: 'DELETE', headers: { cookie: `__Host-ap_session=${token}` } }), environment);
    expect(response.status).toBe(403);
    expect((await response.json()).error.type).toBe('csrf_failed');
    const clear = vi.spyOn(Store.prototype, 'clearLogs').mockResolvedValue();
    const allowed = await app.fetch(new Request(`${base}/api/logs`, { method: 'DELETE', headers: { cookie: `__Host-ap_session=${token}`, 'x-csrf-token': await sessionCsrf(token) } }), environment);
    expect(allowed.status).toBe(200);
    expect(clear).toHaveBeenCalledOnce();
  });
});
