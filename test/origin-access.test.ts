import { describe, expect, it, vi } from 'vitest';
import app from '../src/index';
import type { Bindings } from '../src/types';

const customOrigin = 'https://gateway.example.com';
const workersOrigin = 'https://ap-gateway.example.com';
const navigationHeaders = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', accept: 'text/html' };
function request(path: string, options: RequestInit = {}, origin = customOrigin, publicAccess = true) {
  const assets = vi.fn(async (request: Request) => new Response(request.method === 'HEAD' ? null : '<!doctype html><title>AP Gateway</title>', { headers: { 'content-type': 'text/html', vary: 'Accept-Encoding' } }));
  const env = { APP_ENV: publicAccess ? 'cloud-test' : 'local', AUTH_ENABLED: 'false', ALLOW_UNAUTHENTICATED_PUBLIC: String(publicAccess), ASSETS: { fetch: assets } } as unknown as Bindings;
  return { response: app.fetch(new Request(`${origin}${path}`, options), env), assets };
}

describe('custom domain origin checks', () => {
  for (const origin of [customOrigin, workersOrigin]) for (const path of ['/', '/index.html']) for (const method of ['GET', 'HEAD']) {
    it(`allows cross-site document ${method} navigation to ${origin}${path}`, async () => {
      const { response, assets } = request(path, { method, headers: navigationHeaders }, origin);
      const result = await response;
      expect(result.status).toBe(200);
      expect(assets).toHaveBeenCalledTimes(1);
      expect(result.headers.get('content-type')).toContain('text/html');
      expect(result.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(result.headers.get('vary')).toContain('Accept-Encoding');
      for (const header of ['Origin', 'Sec-Fetch-Site', 'Sec-Fetch-Mode', 'Sec-Fetch-Dest']) expect(result.headers.get('vary')).toContain(header);
      expect(result.headers.has('access-control-allow-origin')).toBe(false);
    });
  }
  it('allows an external-origin GET document navigation without allowing external-origin fetches', async () => {
    const headers = { ...navigationHeaders, origin: 'https://example.com' };
    expect((await request('/', { headers }).response).status).toBe(200);
    expect((await request('/', { headers: { ...headers, 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' } }).response).status).toBe(403);
  });
  it.each(['/api/channels', '/api/export', '/api/settings', '/v1/models', '/v1beta/models', '/healthz', '/app.js', '/unknown'])('does not exempt %s even when navigation headers are supplied', async path => {
    const { response, assets } = request(path, { headers: navigationHeaders });
    const result = await response;
    expect(result.status).toBe(403);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(assets).not.toHaveBeenCalled();
  });
  it.each(['POST', 'PUT', 'DELETE', 'OPTIONS'])('does not exempt cross-site %s', async method => {
    expect((await request('/', { method, headers: navigationHeaders }).response).status).toBe(403);
    expect((await request('/api/channels', { method, headers: navigationHeaders }).response).status).toBe(403);
  });
  it.each(['iframe', 'frame', 'embed', 'empty', 'image', 'script'])('does not exempt cross-site destination %s', async destination => {
    expect((await request('/', { headers: { ...navigationHeaders, 'sec-fetch-dest': destination } }).response).status).toBe(403);
  });
  it('requires both document navigation metadata fields for the exception', async () => {
    expect((await request('/', { headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' } }).response).status).toBe(403);
    expect((await request('/', { headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'document' } }).response).status).toBe(403);
  });
  it('allows same-origin API requests and keeps origins isolated', async () => {
    expect((await request('/healthz', { headers: { origin: customOrigin, 'sec-fetch-site': 'same-origin' } }).response).status).toBe(200);
    expect((await request('/healthz', { headers: { origin: workersOrigin, 'sec-fetch-site': 'same-site' } }).response).status).toBe(403);
  });
  it('allows direct address-bar and CLI access without browser fetch headers', async () => {
    expect((await request('/').response).status).toBe(200);
    expect((await request('/', { headers: { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } }).response).status).toBe(200);
    expect((await request('/healthz').response).status).toBe(200);
  });
  it('keeps the local-only guard in force before navigation handling', async () => {
    expect((await request('/', { headers: navigationHeaders }, customOrigin, false).response).status).toBe(403);
  });
  it('does not trust forwarded host or allow sandboxed null origin API access', async () => {
    expect((await request('/healthz', { headers: { origin: 'https://example.com', 'x-forwarded-host': 'example.com' } }).response).status).toBe(403);
    expect((await request('/healthz', { headers: { origin: 'null' } }).response).status).toBe(403);
  });
  it('keeps same-origin preflight and rejects external preflight', async () => {
    const result = await request('/api/channels', { method: 'OPTIONS', headers: { origin: customOrigin } }).response;
    expect(result.status).toBe(204);
    expect(result.headers.get('access-control-allow-origin')).toBe(customOrigin);
    expect((await request('/api/channels', { method: 'OPTIONS', headers: { origin: 'https://example.com' } }).response).status).toBe(403);
  });
});
