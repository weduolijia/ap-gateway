import { describe, expect, it } from 'vitest';
import { authEnabled, clientApiKey, requireCsrf, sessionCookie, sessionCsrf, sessionToken, upstreamRequest } from '../src/access';

const session = 'a'.repeat(64);
const apiKey = `sk-ap-${'b'.repeat(64)}`;
describe('authentication boundaries', () => {
  it('defaults cloud deployments to protected and allows explicit local development', () => {
    expect(authEnabled({ APP_ENV: 'cloud-test' })).toBe(true);
    expect(authEnabled({ APP_ENV: 'local' })).toBe(false);
    expect(authEnabled({ APP_ENV: 'local', AUTH_ENABLED: 'true' })).toBe(true);
  });
  it('uses a host-only secure HttpOnly session cookie over HTTPS', () => {
    const value = sessionCookie('https://example.com', session, new Date(Date.now() + 3600000).toISOString());
    expect(value).toContain('__Host-ap_session=');
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) expect(value).toContain(flag);
    expect(value).not.toContain('Domain=');
    expect(sessionCookie('https://example.com', '')).toContain('Max-Age=0');
  });
  it('rejects ambiguous or malformed session cookies and insecure cookie names on HTTPS', () => {
    expect(sessionToken(new Request('https://example.com', { headers: { cookie: `__Host-ap_session=${session}` } }))).toBe(session);
    expect(sessionToken(new Request('https://example.com', { headers: { cookie: `ap_session=${session}` } }))).toBeNull();
    expect(sessionToken(new Request('https://example.com', { headers: { cookie: `__Host-ap_session=${session}; __Host-ap_session=${session}` } }))).toBeNull();
    expect(sessionToken(new Request('https://example.com', { headers: { cookie: '__Host-ap_session=invalid' } }))).toBeNull();
  });
  it('requires a session-bound CSRF token for mutations', async () => {
    await expect(requireCsrf(new Request('https://example.com', { method: 'POST' }), session)).rejects.toMatchObject({ code: 'csrf_failed' });
    await expect(requireCsrf(new Request('https://example.com', { method: 'POST', headers: { 'x-csrf-token': await sessionCsrf(session) } }), session)).resolves.toBeUndefined();
    await expect(requireCsrf(new Request('https://example.com'), session)).resolves.toBeUndefined();
  });
  it('accepts supported gateway-key headers and rejects conflicting credentials', () => {
    for (const headers of [{ authorization: `Bearer ${apiKey}` }, { 'x-api-key': apiKey }, { 'x-goog-api-key': apiKey }]) expect(clientApiKey(new Request('https://example.com', { headers }))).toBe(apiKey);
    expect(() => clientApiKey(new Request('https://example.com', { headers: { authorization: `Bearer ${apiKey}`, 'x-api-key': `sk-ap-${'c'.repeat(64)}` } }))).toThrow();
    expect(() => clientApiKey(new Request('https://example.com', { headers: { authorization: 'Bearer upstream-key' } }))).toThrow();
  });
  it('removes every gateway credential before constructing an upstream request', async () => {
    const request = new Request('https://example.com/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'x-api-key': apiKey, 'x-goog-api-key': apiKey, cookie: `__Host-ap_session=${session}`, 'x-csrf-token': await sessionCsrf(session), 'x-ap-channel': 'test', 'user-agent': 'client' } });
    const cleaned = upstreamRequest(request);
    for (const name of ['authorization', 'x-api-key', 'x-goog-api-key', 'cookie', 'x-csrf-token']) expect(cleaned.headers.has(name)).toBe(false);
    expect(cleaned.headers.get('x-ap-channel')).toBe('test');
    expect(cleaned.headers.get('user-agent')).toBe('client');
  });
});
