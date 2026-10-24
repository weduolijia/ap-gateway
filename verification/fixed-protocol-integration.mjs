import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';

const base = 'http://127.0.0.1:8788';
const { password } = JSON.parse(await readFile(new URL('../.wrangler/auth-verification/login.json', import.meta.url), 'utf8'));
const protocols = ['openai', 'responses', 'anthropic', 'gemini'];
const captured = [];
const channels = new Map();
const checks = [];
const keyName = 'External-client compatibility test';
const model = 'compat-model';
const answer = 'COMPAT_OK';
let cookie = '';
let csrf = '';
let gatewayKey = '';
let keyId;
const item = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: answer, annotations: [] }] };
const jsonResults = {
  openai: { id: 'chatcmpl_fixture', object: 'chat.completion', model, choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
  responses: { id: 'resp_fixture', object: 'response', model, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
  anthropic: { id: 'msg_fixture', type: 'message', model, role: 'assistant', content: [{ type: 'text', text: answer }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
  gemini: { responseId: 'gemini_fixture', candidates: [{ index: 0, content: { role: 'model', parts: [{ text: answer }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } },
};
const event = (data, name) => `${name ? `event: ${name}\n` : ''}data: ${JSON.stringify(data)}\n\n`;
const streamResults = {
  openai: [event({ choices: [{ index: 0, delta: { role: 'assistant', content: answer }, finish_reason: null }] }), event({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: jsonResults.openai.usage }), 'data: [DONE]\n\n'],
  responses: [event({ type: 'response.created', response: { ...jsonResults.responses, output: [], status: 'in_progress' } }), event({ type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } }), event({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: answer }), event({ type: 'response.completed', response: jsonResults.responses })],
  anthropic: [event({ type: 'message_start', message: { ...jsonResults.anthropic, content: [], stop_reason: null } }), event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }), event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: answer } }), event({ type: 'content_block_stop', index: 0 }), event({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }), event({ type: 'message_stop' })],
  gemini: [event({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: answer }] } }] }), event({ candidates: [{ index: 0, finishReason: 'STOP' }], usageMetadata: jsonResults.gemini.usageMetadata })],
};
const upstream = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  const protocol = request.url.split('/')[1].replace(/^mock-/, '');
  captured.push({ path: request.url, protocol, body, authorization: request.headers.authorization });
  const stream = protocol === 'gemini' ? request.url.includes(':streamGenerateContent') : body.stream === true;
  if (!stream) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(jsonResults[protocol])); return; }
  response.setHeader('content-type', 'text/event-stream');
  for (const frame of streamResults[protocol]) {
    if (response.destroyed) return;
    response.write(frame);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  response.end();
});
upstream.listen(0, '127.0.0.1');await once(upstream, 'listening');
const mockBase = `http://127.0.0.1:${upstream.address().port}`;
const request = (path, options = {}, admin = true) => fetch(base + path, { ...options, headers: { 'content-type': 'application/json', ...(admin && cookie ? { cookie, 'x-csrf-token': csrf } : {}), ...options.headers }, body: options.body === undefined ? undefined : JSON.stringify(options.body), signal: AbortSignal.timeout(15000) });
async function json(path, options = {}) { const response = await request(path, options); assert.ok(response.ok, `${path} HTTP ${response.status}: ${(await response.clone().text()).slice(0,300)}`); return response.json(); }
async function check(name, run) { await run(); checks.push(name); console.log(`PASS ${name}`); }
const endpoint = (protocol, stream) => protocol === 'openai' ? '/v1/chat/completions' : protocol === 'responses' ? '/v1/responses' : protocol === 'anthropic' ? '/v1/messages' : `/v1beta/models/${model}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`;
function body(protocol, stream) {
  if (protocol === 'gemini') return { contents: [{ role: 'user', parts: [{ text: 'hello' }] }], generationConfig: { maxOutputTokens: 32 } };
  if (protocol === 'responses') return { model, input: 'hello', stream, max_output_tokens: 32 };
  return { model, messages: [{ role: 'user', content: 'hello' }], stream, max_tokens: 32 };
}
async function clientCall(incoming, outgoing, payload, override = 'auto') {
  return request(endpoint(incoming, payload.stream === true), { method: 'POST', headers: { authorization: `Bearer ${gatewayKey}`, 'x-ap-channel': channels.get(outgoing), 'x-ap-protocol': override }, body: payload }, false);
}
try {
  const login = await request('/api/auth/login', { method: 'POST', body: { password } }, false);
  assert.equal(login.status, 200);cookie = login.headers.get('set-cookie').split(';')[0];csrf = (await login.json()).csrfToken;
  const created = await json('/api/keys', { method: 'POST', body: { name: keyName, expiresInDays: 1 } });gatewayKey = created.secret;keyId = created.key.id;
  for (const outgoing of protocols) {
    const channel = (await json('/api/channels', { method: 'POST', body: { name: `Fixed ${outgoing} upstream`, baseUrl: `${mockBase}/mock-${outgoing}`, apiKeys: ['mock-upstream-secret'], protocol: outgoing, models: [model] } })).channel;
    channels.set(outgoing, channel.id);
  }
  for (const outgoing of protocols) for (const incoming of protocols) await check(`API-key client ${incoming} -> fixed ${outgoing} JSON and SSE`, async () => {
    for (const stream of [false, true]) {
      const response = await request(endpoint(incoming, stream), { method: 'POST', headers: { authorization: `Bearer ${gatewayKey}`, 'x-ap-channel': channels.get(outgoing), 'x-ap-protocol': 'auto' }, body: body(incoming, stream) }, false);
      const text = await response.text();
      assert.equal(response.status, 200, text.slice(0,400));assert.ok(text.includes(answer));
      const actual = captured.at(-1);
      const expectedPath = outgoing === 'openai' ? `/mock-${outgoing}/v1/chat/completions` : outgoing === 'responses' ? `/mock-${outgoing}/v1/responses` : outgoing === 'anthropic' ? `/mock-${outgoing}/v1/messages` : `/mock-${outgoing}/v1beta/models/${model}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`;
      assert.equal(actual.path, expectedPath);
      assert.equal(response.headers.get('x-ap-incoming-protocol'), incoming);assert.equal(response.headers.get('x-ap-protocol'), outgoing);assert.equal(response.headers.get('x-ap-forwarded'), 'true');
      if (outgoing === 'responses') { assert.ok(Array.isArray(actual.body.input) || typeof actual.body.input === 'string');assert.equal(actual.body.messages, undefined); }
      else if (outgoing === 'gemini') assert.ok(Array.isArray(actual.body.contents));
      else assert.ok(Array.isArray(actual.body.messages));
      if (stream) assert.ok(text.includes(incoming === 'openai' ? '[DONE]' : incoming === 'responses' ? 'response.completed' : incoming === 'anthropic' ? 'message_stop' : 'finishReason'));
      else { const parsed = JSON.parse(text);assert.ok(incoming === 'openai' ? parsed.choices : incoming === 'responses' ? parsed.output : incoming === 'anthropic' ? parsed.content : parsed.candidates); }
    }
  });
  await check('fixed Responses ignores conflicting Chat override and preserves SDK metadata', async () => {
    const payload = { ...body('openai', false), metadata: { app: 'compat-test' }, user: 'test-user', service_tier: 'auto', prompt_cache_key: 'test-cache', store: false, frequency_penalty: 0, presence_penalty: 0, logprobs: false, top_logprobs: 0, n: 1, reasoning_effort: 'low', verbosity: 'low' };
    const response = await clientCall('openai', 'responses', payload, 'openai');
    assert.equal(response.status, 200, await response.text());
    const actual = captured.at(-1);assert.equal(actual.path, '/mock-responses/v1/responses');
    assert.deepEqual(actual.body.metadata, payload.metadata);assert.equal(actual.body.reasoning.effort, 'low');assert.equal(actual.body.text.verbosity, 'low');assert.equal(actual.body.max_output_tokens, 32);
  });
  await check('Chat tool history converts to Responses function items', async () => {
    const payload = { ...body('openai', false), messages: [{ role: 'user', content: 'weather' }, { role: 'assistant', content: null, reasoning_content: null, annotations: [], tool_calls: [{ id: 'call_weather', type: 'function', function: { name: 'weather', arguments: '{"city":"Paris"}' } }] }, { role: 'tool', tool_call_id: 'call_weather', content: '22C' }], tools: [{ type: 'function', function: { name: 'weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }], tool_choice: 'auto' };
    const response = await clientCall('openai', 'responses', payload);assert.equal(response.status, 200, await response.text());
    const actual = captured.at(-1).body;assert.ok(actual.input.some(item => item.type === 'function_call' && item.call_id === 'call_weather'));assert.ok(actual.input.some(item => item.type === 'function_call_output' && item.call_id === 'call_weather'));assert.equal(actual.tools[0].name, 'weather');
  });
  await check('conversion failures report planned Responses and never contact Chat upstream', async () => {
    const before = captured.length;
    const response = await clientCall('openai', 'responses', { ...body('openai', false), n: 2 });
    assert.equal(response.status, 400);assert.equal(captured.length, before);
    assert.equal(response.headers.get('x-ap-protocol'), 'responses');assert.equal(response.headers.get('x-ap-forwarded'), 'false');assert.equal(response.headers.get('x-ap-attempts'), '0');
    const result = await response.json();assert.equal(result.error.type, 'unsupported_protocol_conversion');
    await new Promise(resolve => setTimeout(resolve, 100));
    const log = (await json('/api/logs')).logs.find(log => log.id === response.headers.get('x-ap-request-id'));
    assert.equal(log.upstreamProtocol, 'responses');assert.equal(log.attempts, 0);assert.ok(log.errorMessage.includes('n=1'));
  });
  await check('optional bookkeeping omissions are recorded without exposing field values', async () => {
    const response = await clientCall('openai', 'anthropic', { ...body('openai', false), metadata: { private: 'do-not-log-value' }, user: 'private-user-value' });
    assert.equal(response.status, 200, await response.text());
    const warning = response.headers.get('x-ap-conversion-warnings');assert.ok(warning.includes('metadata omitted'));assert.ok(!warning.includes('do-not-log-value'));
    await new Promise(resolve => setTimeout(resolve, 100));
    const log = (await json('/api/logs')).logs.find(log => log.id === response.headers.get('x-ap-request-id'));assert.ok(log.conversionWarnings.length);assert.ok(!JSON.stringify(log).includes('private-user-value'));
  });
} finally {
  for (const id of channels.values()) await request(`/api/channels/${id}`, { method: 'DELETE' });
  if (keyId) await request(`/api/keys/${keyId}`, { method: 'DELETE' });
  if (cookie) await request('/api/auth/logout', { method: 'POST', body: {} });
  upstream.closeAllConnections();await new Promise(resolve => upstream.close(resolve));
  await writeFile(new URL('./fixed-protocol-integration-result.json', import.meta.url), JSON.stringify({ verifiedAt: new Date().toISOString(), source: 'External API-key client -> local workerd -> captured HTTP mock upstream', realModelCalls: 0, passed: checks.length, checks }, null, 2));
}
console.log(`Fixed protocol compatibility integration complete: ${checks.length} checks passed.`);
