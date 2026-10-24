import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';

const base = process.env.AP_TEST_URL || 'http://127.0.0.1:8787';
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname)) throw new Error('Integration tests require a local gateway');
const checks = [];
const created = [];
const captured = [];
let mode = 'normal';
let cancelled = false;
const server = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  captured.push({ path: request.url, headers: request.headers, body });
  if (request.method === 'GET') {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ data: [{ id: 'mock-model' }, { id: 'second-model' }] }));
    return;
  }
  if (mode === 'unauthorized' || mode === 'limited' || mode === 'missing-model') {
    response.writeHead(mode === 'unauthorized' ? 401 : mode === 'limited' ? 429 : 404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { type: mode === 'missing-model' ? 'not_found' : mode, message: mode === 'missing-model' ? 'Model unavailable' : mode } }));
    return;
  }
  if (mode === 'fallback' && request.url !== '/v1/chat/completions') {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { code: 'endpoint_not_found' } }));
    return;
  }
  if (body.stream) {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = value => response.write(`data: ${JSON.stringify({ id: 'mock-result', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, ...value }] })}\n\n`);
    emit({ delta: { role: 'assistant' }, finish_reason: null });
    if (mode === 'cancel') {
      const interval = setInterval(() => emit({ delta: { content: '正在输出' }, finish_reason: null }), 30);
      response.on('close', () => { cancelled = true; clearInterval(interval); });
      return;
    }
    setTimeout(() => {
      emit({ delta: { content: '你好，streaming works' }, finish_reason: null });
      if (mode !== 'truncated') {
        emit({ delta: {}, finish_reason: 'stop' });
        response.write('data: [DONE]\n\n');
      }
      response.end();
    }, 50);
    return;
  }
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ id: 'mock-result', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'Mock upstream works' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } }));
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const upstream = `http://127.0.0.1:${server.address().port}`;
const requestApi = (path, options = {}) => fetch(`${base}${path}`, { ...options, signal: options.signal ?? AbortSignal.timeout(15000), headers: { 'content-type': 'application/json', ...options.headers }, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
async function jsonApi(path, options = {}) {
  const response = await requestApi(path, options);
  assert.ok(response.ok, `${path}: HTTP ${response.status} ${await response.clone().text()}`);
  return response.json();
}
async function check(name, run) { await run(); checks.push(name); console.log(`PASS ${name}`); }
const protocols = ['openai', 'responses', 'anthropic', 'gemini'];
const paths = { openai: '/v1/chat/completions', responses: '/v1/responses', anthropic: '/v1/messages', gemini: '/v1beta/models/ap-demo:generateContent' };
const terminal = { openai: '[DONE]', responses: 'response.completed', anthropic: 'message_stop', gemini: 'finishReason' };
const payload = (protocol, stream = false) => protocol === 'gemini' ? { contents: [{ role: 'user', parts: [{ text: 'Hello' }] }] } : { model: 'ap-demo', stream, ...(protocol === 'responses' ? { input: 'Hello' } : { messages: [{ role: 'user', content: 'Hello' }], ...(protocol === 'anthropic' ? { max_tokens: 100 } : {}) }) };
let channel;
try {
  await check('health and local access guards', async () => {
    assert.equal((await jsonApi('/healthz')).authMode, 'disabled');
    assert.equal((await requestApi('/api/channels', { headers: { origin: 'https://example.com' } })).status, 403);
    assert.equal((await requestApi('/api/channels', { method: 'POST', body: { invalid: true } })).status, 400);
  });
  await check('create channel and preserve masked key', async () => {
    const result = await jsonApi('/api/channels', { method: 'POST', body: { name: `Integration ${Date.now()}`, baseUrl: upstream, apiKey: 'integration-secret', protocol: 'auto', models: ['mock-model'], modelMap: { alias: 'mock-model' }, headers: { 'x-test-header': 'custom' } } });
    channel = result.channel;
    created.push(channel.id);
    assert.equal(channel.hasApiKey, true);
    assert.equal(channel.apiKey, undefined);
    assert.ok(!JSON.stringify(await jsonApi('/api/channels')).includes('integration-secret'));
    await jsonApi(`/api/channels/${channel.id}`, { method: 'PUT', body: { apiKey: '' } });
    assert.equal((await jsonApi(`/api/channels/${channel.id}/probe`, { method: 'POST' })).models.length, 2);
  });
  await check('HTTP forwarding, model mapping and editable fingerprints', async () => {
    const output = await jsonApi('/v1/chat/completions', { method: 'POST', headers: { 'x-ap-channel': channel.id, 'x-ap-fingerprint': 'codex', cookie: 'private=1', 'x-client-test': 'preserved' }, body: { model: 'alias', messages: [{ role: 'user', content: 'Hello' }] } });
    assert.equal(output.choices[0].message.content, 'Mock upstream works');
    const incoming = captured.at(-1);
    assert.equal(incoming.body.model, 'mock-model');
    assert.equal(incoming.headers.authorization, 'Bearer integration-secret');
    assert.equal(incoming.headers.originator, 'codex_cli_rs');
    assert.equal(incoming.headers['x-test-header'], 'custom');
    assert.equal(incoming.headers['x-client-test'], 'preserved');
    assert.equal(incoming.headers.cookie, undefined);
    assert.equal(incoming.headers['x-ap-channel'], undefined);
  });
  await check('automatic endpoint negotiation and successful protocol cache', async () => {
    mode = 'fallback';
    const options = { method: 'POST', headers: { 'x-ap-channel': channel.id }, body: { model: 'fallback-model', input: 'Hello' } };
    const response = await requestApi('/v1/responses', options);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-ap-protocol'), 'openai');
    assert.equal(response.headers.get('x-ap-attempts'), '2');
    assert.equal((await response.json()).output[0].content[0].text, 'Mock upstream works');
    await new Promise(resolve => setTimeout(resolve, 100));
    const cached = await requestApi('/v1/responses', options);
    assert.equal(cached.headers.get('x-ap-attempts'), '1');
    await cached.arrayBuffer();
  });
  await check('401, 429 and model 404 never trigger retries', async () => {
    for (const [testMode, status] of [['unauthorized', 401], ['limited', 429], ['missing-model', 404]]) {
      mode = testMode;
      const before = captured.length;
      const response = await requestApi('/v1/responses', { method: 'POST', headers: { 'x-ap-channel': channel.id }, body: { model: `error-${testMode}`, input: 'Hello' } });
      assert.equal(response.status, status);
      assert.equal(captured.length - before, 1);
    }
    mode = 'normal';
  });
  for (const incoming of protocols) for (const outgoing of protocols) {
    await check(`local demo ${incoming} -> ${outgoing} JSON and SSE`, async () => {
      for (const stream of [false, true]) {
        const path = incoming === 'gemini' && stream ? paths[incoming].replace('generateContent', 'streamGenerateContent') : paths[incoming];
        const response = await requestApi(path, { method: 'POST', headers: { 'x-ap-channel': 'demo', 'x-ap-protocol': outgoing }, body: payload(incoming, stream) });
        assert.equal(response.status, 200);
        const body = await response.text();
        assert.ok(body.includes(stream ? terminal[incoming] : 'AP Gateway'));
        assert.ok(!body.includes('upstream_stream_error'), body);
      }
    });
  }
  await check('streamed HTTP response arrives before completion', async () => {
    mode = 'normal';
    const response = await requestApi('/v1/chat/completions', { method: 'POST', headers: { 'x-ap-channel': channel.id, 'x-ap-protocol': 'openai' }, body: { model: 'mock-model', messages: [{ role: 'user', content: 'Hello' }], stream: true } });
    const reader = response.body.getReader();
    const initial = await reader.read();
    assert.ok(new TextDecoder().decode(initial.value).includes('assistant'));
    let rest = '';
    for (;;) { const next = await reader.read(); if (next.done) break; rest += new TextDecoder().decode(next.value); }
    assert.ok(rest.includes('[DONE]'));
  });
  await check('truncated streams report failure and do not fabricate completion', async () => {
    mode = 'truncated';
    const response = await requestApi('/v1/chat/completions', { method: 'POST', headers: { 'x-ap-channel': channel.id, 'x-ap-protocol': 'openai' }, body: { model: 'mock-model', messages: [], stream: true } });
    const body = await response.text();
    assert.ok(body.includes('upstream_stream_error'));
    assert.ok(!body.includes('[DONE]'));
  });
  await check('client cancellation closes upstream connection', async () => {
    mode = 'cancel';
    const abort = new AbortController();
    const response = await requestApi('/v1/chat/completions', { method: 'POST', signal: abort.signal, headers: { 'x-ap-channel': channel.id, 'x-ap-protocol': 'openai' }, body: { model: 'mock-model', messages: [], stream: true } });
    const reader = response.body.getReader();
    await reader.read();
    await reader.cancel();
    abort.abort();
    for (let attempt = 0; attempt < 40 && !cancelled; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(cancelled, true);
    mode = 'normal';
  });
  await check('logs retain failures without storing credentials or prompts', async () => {
    const logs = (await jsonApi('/api/logs')).logs.filter(log => log.channelId === channel.id);
    assert.ok(logs.some(log => log.outcome === 'error'));
    assert.ok(logs.some(log => log.outcome === 'cancelled'));
    assert.ok(!JSON.stringify(logs).includes('integration-secret'));
    assert.ok(logs.every(log => log.prompt === undefined && log.body === undefined));
    const exported = await jsonApi('/api/export');
    assert.ok(!JSON.stringify(exported).includes('integration-secret'));
  });
} finally {
  for (const channelId of created) await requestApi(`/api/channels/${channelId}`, { method: 'DELETE' }).catch(() => {});
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await mkdir(new URL('./', import.meta.url), { recursive: true });
  await writeFile(new URL('./local-integration-result.json', import.meta.url), JSON.stringify({ checkedAt: new Date().toISOString(), base, passed: checks.length, checks }, null, 2));
}
console.log(`Local integration complete: ${checks.length} checks passed.`);
