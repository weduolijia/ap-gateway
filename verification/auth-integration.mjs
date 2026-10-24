import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { cloudBaseUrl, readAdminCredentials } from './credentials.mjs';

const mode = process.argv[2] || 'local';
assert.ok(['local', 'cloud'].includes(mode));
const base = mode === 'cloud' ? cloudBaseUrl() : 'http://127.0.0.1:8788';
const { password } = await readAdminCredentials(mode);
const checks = [];
const keyIds = [];
const channelIds = [];
let cookie = '';
let csrf = '';
let server;
let activePassword = password;
const request = (path, options = {}, credentials = true) => fetch(`${base}${path}`, { ...options, headers: { 'content-type': 'application/json', ...(credentials && cookie ? { cookie, 'x-csrf-token': csrf } : {}), ...options.headers }, body: options.body === undefined ? undefined : JSON.stringify(options.body), redirect: 'manual', signal: AbortSignal.timeout(30000) });
async function json(path, options = {}, credentials = true) {
  const response = await request(path, options, credentials);
  assert.ok(response.ok, `${path} HTTP ${response.status}`);
  return response.json();
}
async function adopt(response) {
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.authenticated, true);
  assert.match(data.csrfToken, /^[a-f0-9]{64}$/);
  const setCookie = response.headers.get('set-cookie');
  assert.ok(setCookie.includes('HttpOnly') && setCookie.includes('SameSite=Lax'));
  if (mode === 'cloud') assert.ok(setCookie.includes('Secure') && setCookie.startsWith('__Host-ap_session='));
  cookie = setCookie.split(';')[0]; csrf = data.csrfToken;
}
async function check(name, run) { await run(); checks.push(name); console.log(`PASS ${name}`); }
async function issue(name = 'Auth integration') {
  const issued = await json('/api/keys', { method: 'POST', body: { name, expiresInDays: 1 } });
  assert.match(issued.secret, /^sk-ap-[a-f0-9]{64}$/);
  keyIds.push(issued.key.id);
  return issued;
}
try {
  await check('anonymous dashboard is a login shell and protected APIs reject', async () => {
    assert.equal((await json('/api/auth/session', {}, false)).authenticated, false);
    for (const path of ['/api/channels', '/api/settings', '/api/logs', '/api/export', '/api/keys', '/v1/models', '/v1beta/models', '/%61pi/channels', '/%761/models']) assert.equal((await request(path, {}, false)).status, 401);
    const page = await request('/', {}, false);
    assert.equal(page.status, 200);assert.ok((await page.text()).includes('login-password'));
    assert.equal((await json('/healthz', {}, false)).authMode, 'enabled');
  });
  await check('wrong password fails and valid password creates a protected session', async () => {
    assert.equal((await request('/api/auth/login', { method: 'POST', body: { password: 'wrong-password-only-test' } }, false)).status, 401);
    await adopt(await request('/api/auth/login', { method: 'POST', body: { password } }, false));
    assert.equal((await json('/api/auth/session')).authenticated, true);
    assert.ok(Array.isArray((await json('/api/channels')).channels));
  });
  await check('session mutations require CSRF and reject foreign origins', async () => {
    const payload = { name: 'Should never create' };
    assert.equal((await request('/api/keys', { method: 'POST', headers: { cookie }, body: payload }, false)).status, 403);
    assert.equal((await request('/api/keys', { method: 'POST', headers: { origin: 'https://example.com' }, body: payload })).status, 403);
  });
  let issued;
  await check('administrator can retrieve active API keys without verification hashes', async () => {
    issued = await issue();
    const list = await json('/api/keys');
    assert.ok(list.keys.some(key => key.id === issued.key.id && key.preview));
    assert.ok(list.keys.some(key => key.id === issued.key.id && key.secret === issued.secret));
    assert.ok(!JSON.stringify(list).includes('key_hash'));
  });
  await check('gateway API keys authorize models but never administration', async () => {
    for (const headers of [{ authorization: `Bearer ${issued.secret}` }, { 'x-api-key': issued.secret }, { 'x-goog-api-key': issued.secret }]) assert.equal((await request('/v1/models', { headers }, false)).status, 200);
    for (const path of ['/api/channels', '/api/keys', '/api/settings', '/api/logs', '/api/export']) assert.equal((await request(path, { headers: { authorization: `Bearer ${issued.secret}` } }, false)).status, 401);
    assert.equal((await request('/v1/models', { headers: { authorization: 'Bearer invalid' } }, false)).status, 401);
  });
  await check('API key and CSRF session both support demo generation', async () => {
    const body = { model: 'ap-demo', messages: [{ role: 'user', content: 'Authentication test' }], stream: true };
    for (const useCookie of [false, true]) {
      const response = await request('/v1/chat/completions', { method: 'POST', headers: { 'x-ap-channel': 'demo', ...(useCookie ? {} : { authorization: `Bearer ${issued.secret}` }) }, body }, useCookie);
      assert.equal(response.status, 200);assert.ok((await response.text()).includes('[DONE]'));
    }
    assert.equal((await request('/v1/chat/completions', { method: 'POST', headers: { cookie, 'x-ap-channel': 'demo' }, body }, false)).status, 403);
  });
  if (mode === 'local') await check('gateway credential and session cookies never reach the upstream', async () => {
    const received = [];
    server = http.createServer(async (request, response) => {
      for await (const chunk of request) {}
      received.push(request.headers);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'mock authentication success' }, finish_reason: 'stop' }] }));
    });
    server.listen(0, '127.0.0.1');await once(server, 'listening');
    const channel = (await json('/api/channels', { method: 'POST', body: { name: 'Authentication upstream', baseUrl: `http://127.0.0.1:${server.address().port}`, apiKeys: ['upstream-only-test-key'], protocol: 'openai' } })).channel;
    channelIds.push(channel.id);
    const body = { model: 'test', messages: [{ role: 'user', content: 'mock' }] };
    await json('/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${issued.secret}`, 'x-ap-channel': channel.id }, body }, false);
    assert.equal(received[0].authorization, 'Bearer upstream-only-test-key');
    await json(`/api/channels/${channel.id}`, { method: 'PUT', body: { apiKeys: null } });
    await json('/v1/chat/completions', { method: 'POST', headers: { 'x-api-key': issued.secret, 'x-ap-channel': channel.id }, body }, false);
    await json('/v1/chat/completions', { method: 'POST', headers: { 'x-ap-channel': channel.id }, body });
    for (const headers of received) {
      assert.ok(!JSON.stringify(headers).includes(issued.secret));
      assert.equal(headers.cookie, undefined);assert.equal(headers['x-csrf-token'], undefined);
    }
    assert.equal(received[1].authorization, undefined);assert.equal(received[2].authorization, undefined);
  });
  await check('revocation immediately prevents future model access', async () => {
    await json(`/api/keys/${issued.key.id}`, { method: 'DELETE' });
    assert.equal((await request('/v1/models', { headers: { authorization: `Bearer ${issued.secret}` } }, false)).status, 401);
    assert.ok(!JSON.stringify(await json('/api/keys')).includes(issued.secret));
  });
  await check('only inactive keys can be permanently deleted', async () => {
    const doomed = await issue('Permanent delete candidate');
    const blocked = await request(`/api/keys/${doomed.key.id}/permanent`, { method: 'DELETE' });
    assert.equal(blocked.status, 409);
    assert.equal((await blocked.json()).error.type, 'api_key_active');
    await json(`/api/keys/${doomed.key.id}`, { method: 'DELETE' });
    const deleted = await request(`/api/keys/${doomed.key.id}/permanent`, { method: 'DELETE' });
    assert.equal(deleted.status, 200);
    assert.ok(!(await json('/api/keys')).keys.some(key => key.id === doomed.key.id));
    const again = await request(`/api/keys/${doomed.key.id}/permanent`, { method: 'DELETE' });
    assert.equal(again.status, 404);
    assert.equal((await again.json()).error.type, 'api_key_not_found');
    assert.equal((await request('/v1/models', { headers: { authorization: `Bearer ${doomed.secret}` } }, false)).status, 401);
    keyIds.splice(keyIds.indexOf(doomed.key.id), 1);
  });
  if (mode === 'local') await check('password changes invalidate older sessions and old credentials', async () => {
    const oldCookie = cookie;
    const nextPassword = randomBytes(24).toString('base64url');
    const changed = await request('/api/auth/password', { method: 'POST', body: { currentPassword: password, newPassword: nextPassword } });
    activePassword = nextPassword;
    await adopt(changed);
    assert.equal((await request('/api/channels', { headers: { cookie: oldCookie } }, false)).status, 401);
    assert.equal((await request('/api/auth/login', { method: 'POST', body: { password } }, false)).status, 401);
    const restored = await request('/api/auth/password', { method: 'POST', body: { currentPassword: nextPassword, newPassword: password } });
    await adopt(restored); activePassword = password;
  });
  await check('logout invalidates the cookie and clears session authentication', async () => {
    for (const id of channelIds.splice(0)) await json(`/api/channels/${id}`, { method: 'DELETE' });
    for (const id of keyIds.splice(0)) await json(`/api/keys/${id}`, { method: 'DELETE' });
    const oldCookie = cookie;
    const response = await request('/api/auth/logout', { method: 'POST', body: {} });
    assert.equal(response.status, 200);assert.ok(response.headers.get('set-cookie').includes('Max-Age=0'));
    assert.equal((await request('/api/channels', { headers: { cookie: oldCookie } }, false)).status, 401);
    cookie = '';csrf = '';
  });
  if (mode === 'cloud' && process.env.AP_WORKERS_URL) await check('workers.dev has the same authentication boundary', async () => {
    const response = await fetch(`${cloudBaseUrl('AP_WORKERS_URL')}/api/channels`, { signal: AbortSignal.timeout(20000) });
    assert.equal(response.status, 401);
  });
} finally {
  if (activePassword !== password && cookie) {
    const response = await request('/api/auth/password', { method: 'POST', body: { currentPassword: activePassword, newPassword: password } });
    if (response.ok) await adopt(response);
  }
  if (cookie) {
    for (const id of channelIds) await request(`/api/channels/${id}`, { method: 'DELETE' });
    for (const id of keyIds) await request(`/api/keys/${id}`, { method: 'DELETE' });
    await request('/api/auth/logout', { method: 'POST', body: {} });
  }
  if (server) { server.closeAllConnections();await new Promise(resolve => server.close(resolve)); }
  await writeFile(new URL(`./auth-${mode}-result.json`, import.meta.url), JSON.stringify({ checkedAt: new Date().toISOString(), base, mode, passed: checks.length, checks }, null, 2));
}
console.log(`Authentication ${mode} verification complete: ${checks.length} checks passed.`);
