import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../src/index';
import { AuthService } from '../src/auth';
import { d1Status, runtimeView, workersStatus, PLAN_LIMITS } from '../src/runtime';
import type { Bindings } from '../src/types';

const token = 'a'.repeat(64);
const base = 'https://gateway.example.com';
const env = { DB: {}, AUTH_ENABLED: 'true', APP_ENV: 'cloud-test' } as Bindings;

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function fakeDb(options: { fail?: boolean; tables?: Record<string, number> } = {}) {
  const tables = options.tables ?? { channels: 2, request_logs: 500, settings: 1 };
  const prepare = vi.fn((sql: string) => ({
    bind: (...args: unknown[]) => ({ first: async () => boundFirst(sql, args), all: async () => boundAll(sql) }),
    first: async () => unboundFirst(sql),
    all: async () => boundAll(sql),
  }));
  const boundFirst = async (sql: string, _args: unknown[]) => {
    if (options.fail) throw new Error('d1 down');
    if (sql.includes('COUNT(*) AS requests')) return { requests: 120, errors: 2, avg_ms: 41.4, max_ms: 900 };
    return null;
  };
  const unboundFirst = async (sql: string) => {
    if (options.fail) throw new Error('d1 down');
    if (sql.includes('SELECT 1')) return { ok: 1 };
    if (sql.includes('MIN(time)')) return { oldest: '2026-10-23T00:00:00.000Z', newest: '2026-10-24T00:00:00.000Z' };
    if (sql.includes('COUNT(*) AS rows')) return { rows: 500, payload: 120000 };
    return null;
  };
  const boundAll = async (sql: string) => {
    if (options.fail) throw new Error('d1 down');
    if (sql.includes('sqlite_master')) return { results: Object.keys(tables).map(name => ({ name })) };
    return { results: [] };
  };
  return { prepare } as unknown as D1Database;
}

describe('runtime status without an API token', () => {
  it('reports D1 tables, rows and log window from the database itself', async () => {
    const view = await runtimeView(fakeDb(), {});
    expect(view.tokenConfigured).toBe(false);
    expect(view.d1).toMatchObject({ reachable: true, sizeSource: 'unavailable', sizeBytes: null, requestLogRows: 500 });
    expect(view.d1.logWindow).toEqual({ oldest: '2026-10-23T00:00:00.000Z', newest: '2026-10-24T00:00:00.000Z' });
    expect(view.d1.tables.map(table => table.name)).toEqual(['channels', 'request_logs', 'settings']);
    expect(view.workers).toMatchObject({ requestsToday: 120, errorsToday: 2, averageDurationMs: 41, maxDurationMs: 900, source: 'request-log' });
    expect(view.workers.accountUsage.available).toBe(false);
    expect(view.d1AccountUsage.available).toBe(false);
    expect(view.workers.planLimits).toEqual(PLAN_LIMITS);
  });
  it('surfaces an unreachable database without throwing', async () => {
    const view = await runtimeView(fakeDb({ fail: true }), {});
    expect(view.d1.reachable).toBe(false);
    expect(view.d1.warnings).toContain('D1 connection failed');
    expect((await workersStatus(fakeDb({ fail: true }), {})).source).toBe('unavailable');
  });
  it('never calls the Cloudflare API without a token', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await d1Status(fakeDb(), { CF_ACCOUNT_ID: 'acc', CF_D1_DATABASE_ID: 'db' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('runtime status with a metadata token', () => {
  const tokenEnv = { CF_ACCOUNT_ID: 'acc', CF_D1_DATABASE_ID: 'db-id', CF_API_TOKEN: 'cf-token', CF_ANALYTICS_TOKEN: 'analytics-token' };

  it('reads the database file size from the metadata endpoint and calculates the share of the limit', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      seen.push(String(url));
      return Response.json({ result: { file_size: 5 * 1024 * 1024 * 1024 } });
    }));
    const status = await d1Status(fakeDb(), tokenEnv);
    expect(status.sizeSource).toBe('metadata-api');
    expect(status.sizeBytes).toBe(5 * 1024 * 1024 * 1024);
    expect(status.storagePercent).toBe(50);
    expect(seen[0]).toBe('https://api.cloudflare.com/client/v4/accounts/acc/d1/database/db-id');
  });
  it('keeps the panel usable when the metadata endpoint fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('forbidden', { status: 403 })));
    const status = await d1Status(fakeDb(), tokenEnv);
    expect(status.sizeBytes).toBeNull();
    expect(status.warnings.join(' ')).toContain('HTTP 403');
  });
  it('reports Workers and D1 account usage from GraphQL analytics', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.query.includes('workersInvocationsAdaptive')) {
        return Response.json({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [
          { dimensions: { scriptName: 'ap-gateway' }, sum: { requests: 1234, errors: 3 }, quantiles: { cpuTimeP50: 4345, cpuTimeP99: 120701 } },
          { dimensions: { scriptName: 'other' }, sum: { requests: 9999, errors: 0 }, quantiles: { cpuTimeP50: 1, cpuTimeP99: 1 } },
        ] }] } } });
      }
      return Response.json({ data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: [
        { dimensions: { databaseId: 'other-db' }, sum: { rowsRead: 1, rowsWritten: 1 } },
        { dimensions: { databaseId: 'db-id' }, sum: { rowsRead: 5000, rowsWritten: 120 } },
      ] }] } } });
    }));
    const view = await runtimeView(fakeDb(), tokenEnv);
    expect(view.workers.accountUsage).toMatchObject({ available: true, requests: 1234, errors: 3, cpuTimeP50Ms: 4.35, cpuTimeP99Ms: 120.7 });
    expect(view.d1AccountUsage).toMatchObject({ available: true, rowsRead: 5000, rowsWritten: 120 });
  });
  it('accepts a separate analytics token and prefers it over the metadata token', async () => {
    const auth: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      auth.push(`${String(url).includes('graphql') ? 'graphql' : 'metadata'}:${new Headers(init.headers).get('authorization')}`);
      if (String(url).includes('graphql')) return Response.json({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [{ dimensions: { scriptName: 'ap-gateway' }, sum: { requests: 5, errors: 0 }, quantiles: { cpuTimeP50: 1000, cpuTimeP99: 2000 } }], d1AnalyticsAdaptiveGroups: [{ dimensions: { databaseId: 'db-id' }, sum: { rowsRead: 10, rowsWritten: 2 } }] }] } } });
      return Response.json({ result: { file_size: 1024 } });
    }));
    const view = await runtimeView(fakeDb(), { ...tokenEnv, CF_API_TOKEN: 'metadata-token', CF_ANALYTICS_TOKEN: 'analytics-token' });
    expect(view.workers.accountUsage.available).toBe(true);
    expect(view.d1AccountUsage).toMatchObject({ available: true, rowsRead: 10, rowsWritten: 2 });
    expect(auth).toContain('graphql:Bearer analytics-token');
    expect(auth).toContain('metadata:Bearer metadata-token');
  });
  it('degrades gracefully when GraphQL returns errors or a non-200', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: null, errors: [{ message: 'budget' }] })));
    const view = await runtimeView(fakeDb(), tokenEnv);
    expect(view.workers.accountUsage.available).toBe(false);
    expect(view.d1AccountUsage.available).toBe(false);
  });
});

describe('runtime route', () => {
  it('requires an administrator session', async () => {
    const response = await app.fetch(new Request(`${base}/api/runtime`), env);
    expect(response.status).toBe(401);
  });
  it('returns the runtime view for an authenticated session', async () => {
    vi.spyOn(AuthService.prototype, 'checkSession').mockResolvedValue({ expiresAt: new Date(Date.now() + 10000).toISOString(), version: 1 });
    vi.stubGlobal('fetch', vi.fn());
    const response = await app.fetch(new Request(`${base}/api/runtime`, { headers: { cookie: `__Host-ap_session=${token}` } }), { ...env, DB: fakeDb() } as Bindings);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ tokenConfigured: false });
    expect(body.d1).toMatchObject({ reachable: true });
  });
});
