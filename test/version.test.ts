import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import app from '../src/index';
import { APP_VERSION, BUILD_DATE, VERSION_TAG } from '../src/version';
import type { Bindings } from '../src/types';

const base = 'https://gateway.example.com';
const db = { prepare: () => ({ first: async () => ({ ok: 1 }) }) } as unknown as D1Database;
const environment = { DB: db, AUTH_ENABLED: 'true', APP_ENV: 'cloud-test' } as unknown as Bindings;
const request = (path: string, options: RequestInit = {}) => app.fetch(new Request(base + path, options), environment);

describe('version and readiness', () => {
  it('keeps the runtime version in sync with package metadata', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
    expect(pkg.version).toBe(APP_VERSION);
    expect(lock.packages[''].version).toBe(APP_VERSION);
    expect(BUILD_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(VERSION_TAG).toBe(`${APP_VERSION} (${BUILD_DATE})`);
  });
  it('reports the version and build from the health endpoint without caching', async () => {
    const response = await request('/healthz');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, version: APP_VERSION, build: BUILD_DATE, authMode: 'enabled' });
    expect(response.headers.get('x-ap-version')).toBe(VERSION_TAG);
    expect(response.headers.get('cache-control')).toContain('no-store');
  });
  it('checks D1 connectivity at the readiness endpoint', async () => {
    const response = await request('/readyz');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, version: APP_VERSION, build: BUILD_DATE, database: 'ok' });
    const broken = { ...environment, DB: { prepare: () => ({ first: async () => { throw new Error('down'); } }) } } as unknown as Bindings;
    const failed = await app.fetch(new Request(`${base}/readyz`), broken);
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({ ok: false, database: 'unavailable' });
  });
  it('stamps the version header on error and early responses', async () => {
    const unauthorized = await request('/api/keys');
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get('x-ap-version')).toBe(VERSION_TAG);
    const blocked = await request('/healthz', { headers: { origin: 'https://example.com' } });
    expect(blocked.status).toBe(403);
    expect(blocked.headers.get('x-ap-version')).toBe(VERSION_TAG);
  });
});
