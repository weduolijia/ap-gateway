import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';

const base = process.env.AP_TEST_URL || 'http://127.0.0.1:8787';
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname)) throw new Error('Local gateway required');
const created = [];
const captured = [];
const checks = [];
const requestIds = [];
const pool = ['round-robin-alpha', 'round-robin-beta', 'round-robin-gamma'];
let mode = 'normal';
const upstream = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  const key = request.headers.authorization?.replace(/^Bearer /, '') || request.headers['x-api-key'] || request.headers['x-goog-api-key'];
  captured.push({ path: request.url, key, headers: request.headers, body });
  response.setHeader('content-type', 'application/json');
  if (mode === 'limited') { response.writeHead(429); response.end(JSON.stringify({ error: { code: 'rate_limit' } })); return; }
  if (mode === 'fallback' && request.method === 'POST' && request.url !== '/v1/chat/completions') {
    response.writeHead(404); response.end(JSON.stringify({ error: { code: 'endpoint_not_found' } })); return;
  }
  if (request.method === 'GET') { response.end(JSON.stringify({ data: [{ id: 'key-model' }] })); return; }
  if (body.stream) {
    response.setHeader('content-type', 'text/event-stream');
    response.write('data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"key test"},"finish_reason":null}]}\n\n');
    setTimeout(() => response.end('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'), 30);
  } else if (request.url === '/v1/messages') {
    response.end(JSON.stringify({ id: 'msg_test', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'key test' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
  } else if (request.url.startsWith('/v1beta/')) {
    response.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'key test' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } }));
  } else {
    response.end(JSON.stringify({ id: 'key-test', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'key test' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  }
});
upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');
const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
const api = (path, options = {}) => fetch(`${base}${path}`, { ...options, headers: { 'content-type': 'application/json', ...options.headers }, body: options.body === undefined ? undefined : JSON.stringify(options.body), signal: AbortSignal.timeout(20000) });
async function json(path, options = {}) {
  const response = await api(path, options);
  assert.ok(response.ok, `${path} HTTP ${response.status}: ${(await response.clone().text()).slice(0,200)}`);
  return response.json();
}
async function check(name, run) { await run(); checks.push(name); console.log(`PASS ${name}`); }
let channel;
let expectedCursor = 0;
async function complete(options = {}) {
  const protocol = options.protocol || 'openai';
  const path = protocol === 'responses' ? '/v1/responses' : protocol === 'anthropic' ? '/v1/messages' : protocol === 'gemini' ? '/v1beta/models/key-model:generateContent' : '/v1/chat/completions';
  const body = protocol === 'responses' ? { model: 'key-model', input: 'Hello' } : protocol === 'gemini' ? { contents: [{ role: 'user', parts: [{ text: 'Hello' }] }] } : { model: 'key-model', messages: [{ role: 'user', content: 'Hello' }], max_tokens: 32, stream: !!options.stream };
  const response = await api(path, { method: 'POST', headers: { 'x-ap-channel': options.channelId || channel.id, 'x-ap-protocol': options.upstreamProtocol || protocol, ...options.headers }, body });
  const requestId = response.headers.get('x-ap-request-id');
  if (requestId) requestIds.push(requestId);
  const text = await response.text();
  assert.equal(response.status, options.status || 200, text.slice(0,200));
  return { response, text, requestId };
}
try {
  await check('legacy single-key creation remains compatible', async () => {
    const result = await json('/api/channels', { method: 'POST', body: { name: `Key integration ${Date.now()}`, baseUrl: upstreamUrl, apiKey: 'legacy-key', protocol: 'auto', models: ['key-model'] } });
    channel = result.channel; created.push(channel.id);
    assert.equal(channel.keyCount, 1);
    await complete();
    assert.equal(captured.at(-1).key, 'legacy-key');
  });
  await check('pool replacement trims and deduplicates without disclosing keys', async () => {
    const result = await json(`/api/channels/${channel.id}`, { method: 'PUT', body: { apiKeys: [` ${pool[0]} `, pool[1], pool[2], pool[0]] } });
    assert.equal(result.channel.keyCount, 3);
    assert.equal(result.channel.apiKeys, undefined);
    assert.equal(result.channel.apiKey, undefined);
  });
  await check('sequential requests cycle through every key', async () => {
    const before = captured.length;
    for (let requestNumber = 0; requestNumber < 7; requestNumber++) await complete();
    assert.deepEqual(captured.slice(before).map(entry => entry.key), [...pool, ...pool, pool[0]]);
    expectedCursor = 1;
  });
  await check('ordinary edits and legacy blank key preserve pool and cursor', async () => {
    const result = await json(`/api/channels/${channel.id}`, { method: 'PUT', body: { name: 'Renamed key integration', apiKey: '' } });
    assert.equal(result.channel.keyCount, 3);
    await complete();
    assert.equal(captured.at(-1).key, pool[expectedCursor]);
    expectedCursor = 2;
  });
  await check('concurrent requests distribute evenly through atomic D1 allocation', async () => {
    const before = captured.length;
    await Promise.all(Array.from({ length: 12 }, () => complete()));
    const keys = captured.slice(before).map(entry => entry.key);
    assert.equal(keys.length, 12);
    for (const key of pool) assert.equal(keys.filter(value => value === key).length, 4);
  });
  await check('protocol fallback uses one key for the whole logical request', async () => {
    mode = 'fallback';
    const before = captured.length;
    const result = await complete({ protocol: 'responses', upstreamProtocol: 'auto' });
    assert.equal(result.response.headers.get('x-ap-attempts'), '2');
    assert.deepEqual(captured.slice(before).map(entry => entry.key), [pool[expectedCursor], pool[expectedCursor]]);
    expectedCursor = (expectedCursor + 1) % pool.length;
    mode = 'normal';
  });
  await check('429 does not resend and the following request uses the next key', async () => {
    mode = 'limited';
    const before = captured.length;
    await complete({ status: 429 });
    assert.equal(captured.length - before, 1);
    assert.equal(captured.at(-1).key, pool[expectedCursor]);
    expectedCursor = (expectedCursor + 1) % pool.length;
    mode = 'normal';
    await complete();
    assert.equal(captured.at(-1).key, pool[expectedCursor]);
    expectedCursor = (expectedCursor + 1) % pool.length;
  });
  await check('model discovery participates in the same rotation', async () => {
    assert.equal((await json(`/api/channels/${channel.id}/probe`, { method: 'POST' })).models[0], 'key-model');
    assert.equal(captured.at(-1).key, pool[expectedCursor]);
    expectedCursor = (expectedCursor + 1) % pool.length;
  });
  await check('streaming and protocol-specific authentication use selected keys', async () => {
    for (const options of [{ stream: true }, { protocol: 'anthropic' }, { protocol: 'gemini' }]) {
      const result = await complete(options);
      assert.equal(captured.at(-1).key, pool[expectedCursor]);
      if (options.stream) assert.ok(result.text.includes('[DONE]'));
      if (options.protocol === 'anthropic') assert.equal(captured.at(-1).headers['x-api-key'], pool[expectedCursor]);
      if (options.protocol === 'gemini') assert.equal(captured.at(-1).headers['x-goog-api-key'], pool[expectedCursor]);
      expectedCursor = (expectedCursor + 1) % pool.length;
    }
  });
  await check('channels keep independent rotation cursors', async () => {
    const other = (await json('/api/channels', { method: 'POST', body: { name: 'Independent key pool', baseUrl: upstreamUrl, apiKeys: ['independent-one', 'independent-two'], protocol: 'openai' } })).channel;
    created.push(other.id);
    for (const expected of ['independent-one', 'independent-two', 'independent-one']) { await complete({ channelId: other.id }); assert.equal(captured.at(-1).key, expected); }
    await complete();
    assert.equal(captured.at(-1).key, pool[expectedCursor]);
  });
  await check('replacing and reordering pools resets selection to first key', async () => {
    await json(`/api/channels/${channel.id}`, { method: 'PUT', body: { apiKeys: ['new-one', 'new-two'] } });
    await complete(); assert.equal(captured.at(-1).key, 'new-one');
    await json(`/api/channels/${channel.id}`, { method: 'PUT', body: { apiKeys: ['new-two', 'new-one'] } });
    await complete(); assert.equal(captured.at(-1).key, 'new-two');
  });
  await check('logs and exports contain indices and counts but no key material', async () => {
    await new Promise(resolve => setTimeout(resolve, 100));
    const logs = (await json('/api/logs')).logs.filter(log => log.channelId === channel.id);
    assert.ok(logs.length > 5);
    assert.ok(logs.some(log => log.keyIndex === 3 && log.keyCount === 3));
    assert.ok(logs.every(log => log.keyIndex == null || log.keyIndex >= 1 && log.keyIndex <= log.keyCount));
    for (const content of [logs, await json('/api/channels'), await json('/api/export')]) {
      for (const secret of [...pool, 'legacy-key', 'new-one', 'new-two']) assert.ok(!JSON.stringify(content).includes(secret));
    }
  });
  await check('explicit clearing removes all saved keys and restores caller passthrough', async () => {
    const result = await json(`/api/channels/${channel.id}`, { method: 'PUT', body: { apiKeys: null } });
    assert.equal(result.channel.keyCount, 0); assert.equal(result.channel.hasApiKey, false);
    await complete({ headers: { authorization: 'Bearer client-owned-placeholder' } });
    assert.equal(captured.at(-1).key, 'client-owned-placeholder');
  });
  await check('invalid and ambiguous key lists reject without overwriting channel', async () => {
    for (const body of [{ apiKeys: 'wrong' }, { apiKeys: ['bad\nkey'] }, { apiKeys: ['new'], apiKey: 'old' }]) {
      const response = await api(`/api/channels/${channel.id}`, { method: 'PUT', body });
      assert.equal(response.status, 400);
    }
    assert.equal((await json('/api/channels')).channels.find(value => value.id === channel.id).keyCount, 0);
  });
} finally {
  for (const id of created) await api(`/api/channels/${id}`, { method: 'DELETE' }).catch(() => {});
  upstream.closeAllConnections();
  await new Promise(resolve => upstream.close(resolve));
  await writeFile(new URL('./key-rotation-integration-result.json', import.meta.url), JSON.stringify({ verifiedAt: new Date().toISOString(), base, passed: checks.length, checks }, null, 2));
}
console.log(`Key rotation integration complete: ${checks.length} checks passed.`);
