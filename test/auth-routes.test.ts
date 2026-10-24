import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../src/index';
import { AuthService } from '../src/auth';
import { sessionCsrf } from '../src/access';
import { DEFAULT_SETTINGS, DEMO_CHANNEL } from '../src/config';
import { Store } from '../src/store';
import type { Bindings } from '../src/types';

const base = 'https://gateway.example.com';
const token = 'a'.repeat(64);
const key = `sk-ap-${'b'.repeat(64)}`;
const environment = { DB: {}, AUTH_ENABLED: 'true', APP_ENV: 'cloud-test' } as Bindings;
function request(path: string, options: RequestInit = {}) { return app.fetch(new Request(base + path, options), environment); }
afterEach(() => { vi.restoreAllMocks(); });

describe('protected route coverage', () => {
  it.each(['/api/channels', '/api/settings', '/api/logs', '/api/export', '/api/keys', '/v1/models', '/v1beta/models', '/%61pi/channels', '/%61pi/keys', '/api/%6beys', '/%761/models', '/%761beta/models'])('requires authentication for %s', async path => {
    expect((await request(path)).status).toBe(401);
  });
  it.each(['/api/channels', '/%61pi/channels', '/api/keys', '/%61pi/keys'])('protects encoded and normal writes at %s', async path => {
    expect((await request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
  });
  it('does not grant API keys administrative permissions', async () => {
    const apiCheck = vi.spyOn(AuthService.prototype, 'checkApiKey');
    expect((await request('/api/keys', { headers: { authorization: `Bearer ${key}` } })).status).toBe(401);
    expect(apiCheck).not.toHaveBeenCalled();
  });
  it('requires CSRF for cookie-authenticated writes including encoded prefixes', async () => {
    vi.spyOn(AuthService.prototype, 'checkSession').mockResolvedValue({ expiresAt: new Date(Date.now() + 10000).toISOString(), version: 1 });
    for (const path of ['/api/channels', '/%61pi/channels', '/v1/chat/completions']) {
      const response = await request(path, { method: 'POST', headers: { cookie: `__Host-ap_session=${token}`, 'content-type': 'application/json' }, body: '{}' });
      expect(response.status).toBe(403);
      expect((await response.json()).error.type).toBe('csrf_failed');
    }
  });
  it('accepts a valid session-bound write through to validation', async () => {
    vi.spyOn(AuthService.prototype, 'checkSession').mockResolvedValue({ expiresAt: new Date(Date.now() + 10000).toISOString(), version: 1 });
    vi.spyOn(Store.prototype, 'settings').mockResolvedValue(DEFAULT_SETTINGS);
    const response = await request('/api/channels', { method: 'POST', headers: { cookie: `__Host-ap_session=${token}`, 'x-csrf-token': await sessionCsrf(token), 'content-type': 'application/json' }, body: '{}' });
    expect(response.status).toBe(400);
    expect((await response.json()).error.type).toBe('invalid_request');
  });
  it('protects permanent key deletion with session and CSRF before the handler runs', async () => {
    const id = '00000000-0000-0000-0000-000000000000';
    const purge = vi.spyOn(AuthService.prototype, 'purgeApiKey').mockResolvedValue();
    expect((await request(`/api/keys/${id}/permanent`, { method: 'DELETE' })).status).toBe(401);
    vi.spyOn(AuthService.prototype, 'checkSession').mockResolvedValue({ expiresAt: new Date(Date.now() + 10000).toISOString(), version: 1 });
    const blocked = await request(`/api/keys/${id}/permanent`, { method: 'DELETE', headers: { cookie: `__Host-ap_session=${token}` } });
    expect(blocked.status).toBe(403);
    expect((await blocked.json()).error.type).toBe('csrf_failed');
    expect(purge).not.toHaveBeenCalled();
    const response = await request(`/api/keys/${id}/permanent`, { method: 'DELETE', headers: { cookie: `__Host-ap_session=${token}`, 'x-csrf-token': await sessionCsrf(token) } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(purge).toHaveBeenCalledWith(id);
  });
  it('keeps the revoke route separate from permanent deletion', async () => {
    vi.spyOn(AuthService.prototype, 'checkSession').mockResolvedValue({ expiresAt: new Date(Date.now() + 10000).toISOString(), version: 1 });
    const revoke = vi.spyOn(AuthService.prototype, 'revokeApiKey').mockResolvedValue();
    const id = '00000000-0000-0000-0000-000000000000';
    const response = await request(`/api/keys/${id}`, { method: 'DELETE', headers: { cookie: `__Host-ap_session=${token}`, 'x-csrf-token': await sessionCsrf(token) } });
    expect(response.status).toBe(200);
    expect(revoke).toHaveBeenCalledWith(id);
  });
  it('permits a valid gateway key only for model access', async () => {
    vi.spyOn(AuthService.prototype, 'checkApiKey').mockResolvedValue({ id: 'test-key', name: 'test', preview: 'sk-ap-preview', createdAt: new Date().toISOString(), expiresAt: null, revokedAt: null, lastUsedAt: null, secret: null, channelId: null, models: null });
    vi.spyOn(Store.prototype, 'channels').mockResolvedValue([DEMO_CHANNEL]);
    expect((await request('/v1/models', { headers: { authorization: `Bearer ${key}` } })).status).toBe(200);
  });
  it('serves the stored full key to the owner and never to anonymous callers', async () => {
    const listed = [{ id: 'test-key', name: 'test', preview: 'sk-ap-preview', createdAt: new Date().toISOString(), expiresAt: null, revokedAt: null, lastUsedAt: null, secret: key }];
    const list = vi.spyOn(AuthService.prototype, 'listApiKeys').mockResolvedValue(listed);
    expect((await request('/api/keys')).status).toBe(401);
    expect(list).not.toHaveBeenCalled();
    vi.spyOn(AuthService.prototype, 'checkSession').mockResolvedValue({ expiresAt: new Date(Date.now() + 10000).toISOString(), version: 1 });
    const response = await request('/api/keys', { headers: { cookie: `__Host-ap_session=${token}` } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ keys: listed });
  });
  it('keeps health and session discovery public without leaking admin data', async () => {
    expect((await request('/healthz')).status).toBe(200);
    const response = await request('/api/auth/session');
    expect(await response.json()).toEqual({ authMode: 'enabled', authenticated: false });
  });
  it('forces HTTPS before public login and administration', async () => {
    const redirect = await app.fetch(new Request('http://gateway.example.com/'), environment);
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get('location')).toBe(`${base}/`);
    const blocked = await app.fetch(new Request('http://gateway.example.com/api/auth/login', { method: 'POST' }), environment);
    expect(blocked.status).toBe(400);
    expect((await blocked.json()).error.type).toBe('https_required');
  });
});
