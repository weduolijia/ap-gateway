import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { cloudBaseUrl, readAdminCredentials } from './credentials.mjs';

const base = cloudBaseUrl();
const checks = [];
const created = [];
let cookie = '';
let csrf = '';
const call = (path, options = {}) => fetch(`${base}${path}`, { ...options, signal: AbortSignal.timeout(30000), headers: { 'content-type': 'application/json', ...(cookie ? { cookie, 'x-csrf-token': csrf } : {}), ...options.headers }, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
async function json(path, options = {}) {
  const response = await call(path, options);
  assert.ok(response.ok, `${path} HTTP ${response.status}: ${(await response.clone().text()).slice(0,500)}`);
  return response.json();
}
async function check(name, run) { await run(); checks.push(name); console.log(`PASS ${name}`); }
const protocols = ['openai', 'responses', 'anthropic', 'gemini'];
const paths = { openai: '/v1/chat/completions', responses: '/v1/responses', anthropic: '/v1/messages', gemini: '/v1beta/models/ap-demo:generateContent' };
const terminal = { openai: '[DONE]', responses: 'response.completed', anthropic: 'message_stop', gemini: 'finishReason' };
const payload = (protocol, stream) => protocol === 'gemini' ? { contents: [{ role: 'user', parts: [{ text: 'Cloud deployment smoke test' }] }] } : { model: 'ap-demo', stream, ...(protocol === 'responses' ? { input: 'Cloud deployment smoke test' } : { messages: [{ role: 'user', content: 'Cloud deployment smoke test' }], ...(protocol === 'anthropic' ? { max_tokens: 100 } : {}) }) };
try {
  const credentials = await readAdminCredentials('cloud');
  const login = await call('/api/auth/login', { method: 'POST', body: { password: credentials.password } });
  assert.equal(login.status, 200, 'Cloud smoke requires a valid administrator password');
  cookie = login.headers.get('set-cookie').split(';')[0];
  csrf = (await login.json()).csrfToken;
  await check('public HTTPS health and cloud D1 status', async () => {
    const health = await json('/healthz');
    assert.equal(health.ok, true);
    assert.equal(health.environment, 'cloud-test');
    assert.equal(health.authMode, 'enabled');
    const status = await json('/api/status');
    assert.equal(status.environment, 'cloud-test');
    assert.equal(typeof status.settings.defaultChannelId, 'string');
  });
  await check('dashboard assets and security response headers', async () => {
    const page = await call('/');
    assert.equal(page.status, 200);
    assert.ok((await page.text()).includes('AP Gateway'));
    assert.ok(page.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"));
    for (const path of ['/app.js', '/styles.css', '/theme.js']) assert.equal((await call(path)).status, 200);
  });
  await check('cross-site writes and private upstreams rejected', async () => {
    assert.equal((await call('/api/channels', { method: 'POST', headers: { origin: 'https://example.com' }, body: {} })).status, 403);
    assert.equal((await call('/api/channels', { method: 'POST', body: { name: 'Rejected private upstream', baseUrl: 'http://127.0.0.1' } })).status, 400);
  });
  await check('cloud channel persistence, masking, updates and deletion', async () => {
    const result = await json('/api/channels', { method: 'POST', body: { name: `Cloud smoke ${Date.now()}`, baseUrl: 'https://example.com', apiKey: 'cloud-smoke-fake-key', models: ['cloud-smoke-model'], protocol: 'openai', fingerprint: 'codex' } });
    created.push(result.channel.id);
    assert.equal(result.channel.hasApiKey, true);
    assert.equal(result.channel.apiKey, undefined);
    assert.equal(result.channel.apiKeys, undefined);
    assert.equal(result.channel.keyCount, 1);
    const list = await json('/api/channels');
    assert.ok(list.channels.some(channel => channel.id === result.channel.id));
    assert.ok(!JSON.stringify(list).includes('cloud-smoke-fake-key'));
    const updated = await json(`/api/channels/${result.channel.id}`, { method: 'PUT', body: { fingerprint: 'claude-code', apiKey: '' } });
    assert.equal(updated.channel.hasApiKey, true);
    assert.equal(updated.channel.fingerprint, 'claude-code');
    const pool = await json(`/api/channels/${result.channel.id}`, { method: 'PUT', body: { apiKeys: ['cloud-placeholder-one', 'cloud-placeholder-two', 'cloud-placeholder-three'] } });
    assert.equal(pool.channel.keyCount, 3);
    assert.equal(pool.channel.apiKeys, undefined);
    assert.equal((await json(`/api/channels/${result.channel.id}`, { method: 'PUT', body: { name: 'Cloud smoke key pool' } })).channel.keyCount, 3);
    assert.ok(!JSON.stringify(await json('/api/export')).includes('cloud-smoke-fake-key'));
    await json(`/api/channels/${result.channel.id}`, { method: 'DELETE' });
    created.splice(created.indexOf(result.channel.id), 1);
  });
  for (const incoming of protocols) for (const upstream of protocols) {
    await check(`cloud ${incoming} -> ${upstream} JSON and SSE`, async () => {
      for (const stream of [false, true]) {
        const path = incoming === 'gemini' && stream ? paths[incoming].replace('generateContent', 'streamGenerateContent') : paths[incoming];
        const response = await call(path, { method: 'POST', headers: { 'x-ap-channel': 'demo', 'x-ap-protocol': upstream }, body: payload(incoming, stream) });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('x-ap-protocol'), upstream);
        const text = await response.text();
        assert.ok(!text.includes('upstream_stream_error'), text);
        assert.ok(text.includes(stream ? terminal[incoming] : '云端演示已连接'), text);
      }
    });
  }
  await check('cloud model catalogue and persisted request records', async () => {
    assert.ok((await json('/v1/models')).data.some(model => model.id === 'ap-demo'));
    const logs = (await json('/api/logs')).logs;
    assert.ok(logs.some(log => log.channelId === 'demo' && log.outcome === 'ok'));
  });
} finally {
  for (const id of created) await call(`/api/channels/${id}`, { method: 'DELETE' }).catch(() => {});
  if (cookie) await call('/api/auth/logout', { method: 'POST', body: {} }).catch(() => {});
  await writeFile(new URL('./cloud-smoke-result.json', import.meta.url), JSON.stringify({ verifiedAt: new Date().toISOString(), base, passed: checks.length, checks }, null, 2));
}
console.log(`Cloud smoke complete: ${checks.length} checks passed.`);
