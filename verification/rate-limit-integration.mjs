import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';

const base = 'http://127.0.0.1:8787';
const calls = [];
const checks = [];
let mode = 'rate';
let channelId;
const secrets = ['private-integration-one','private-integration-two'];
const upstream = http.createServer(async (request,response) => {
  for await (const chunk of request) {}
  calls.push({ key: request.headers.authorization, path: request.url });
  const headers = { 'content-type': 'application/json', 'x-request-id': 'mock-rate-request' };
  if (mode !== 'missing') { headers['retry-after'] = '12'; headers['x-ratelimit-remaining-requests'] = '0'; headers['x-ratelimit-remaining-tokens'] = '0'; }
  response.writeHead(429, headers);
  response.end(JSON.stringify({ error: { code: 'rate_limit_exceeded', type: 'rate_limit_exceeded', message: mode === 'secret' ? `Key ${secrets[0]} and ${secrets[1]} limited` : 'Channel rate limit reached for model' } }));
});
upstream.listen(0,'127.0.0.1');
await once(upstream,'listening');
const api = (path,options={}) => fetch(base+path,{...options, headers:{'content-type':'application/json',...options.headers},body:options.body===undefined?undefined:JSON.stringify(options.body),signal:AbortSignal.timeout(10000)});
async function check(name,run){await run();checks.push(name);console.log(`PASS ${name}`);}
async function generate(){ return api('/v1/chat/completions',{method:'POST',headers:{'x-ap-channel':channelId},body:{model:'mock-rate-model',messages:[{role:'user',content:'Hello'}]}}); }
try {
  const create = await api('/api/channels',{method:'POST',body:{name:`Rate test ${Date.now()}`,baseUrl:`http://127.0.0.1:${upstream.address().port}`,apiKeys:secrets,protocol:'auto'}});
  assert.equal(create.status,201);channelId=(await create.json()).channel.id;
  await check('HTTP429 keeps upstream reason, delay and correlation metadata',async()=>{
    const response=await generate();const payload=await response.json();
    assert.equal(response.status,429);assert.equal(response.headers.get('retry-after'),'12');
    assert.equal(response.headers.get('x-ap-key-index'),'1');assert.equal(response.headers.get('x-ap-attempts'),'1');
    assert.ok(response.headers.get('x-ap-request-id'));
    assert.equal(payload.error.upstreamCode,'rate_limit_exceeded');
    assert.equal(payload.error.upstreamMessage,'Channel rate limit reached for model');
    assert.equal(payload.error.retryAfterSeconds,12);
    assert.equal(calls.length,1);
  });
  await check('next request rotates once without automatic retries',async()=>{
    const response=await generate();await response.arrayBuffer();
    assert.equal(response.status,429);assert.equal(response.headers.get('x-ap-key-index'),'2');
    assert.equal(calls.length,2);assert.equal(calls[0].key,`Bearer ${secrets[0]}`);assert.equal(calls[1].key,`Bearer ${secrets[1]}`);
  });
  await check('missing Retry-After remains unknown',async()=>{
    mode='missing';const response=await generate();const payload=await response.json();
    assert.equal(response.status,429);assert.equal(response.headers.get('retry-after'),null);assert.equal(payload.error.retryAfterSeconds,undefined);
  });
  await check('all pool credentials are redacted in response and logs',async()=>{
    mode='secret';const response=await generate();const text=await response.text();
    for(const secret of secrets) assert.ok(!text.includes(secret));
    await new Promise(resolve=>setTimeout(resolve,150));
    const logs=JSON.stringify((await(await api('/api/logs')).json()).logs.filter(log=>log.channelId===channelId));
    for(const secret of secrets) assert.ok(!logs.includes(secret));
    assert.ok(logs.includes('rate_limit_exceeded'));
  });
  await check('model discovery preserves HTTP429 and wait metadata',async()=>{
    mode='rate';const before=calls.length;
    const response=await api(`/api/channels/${channelId}/probe`,{method:'POST'});const payload=await response.json();
    assert.equal(response.status,429);assert.equal(response.headers.get('retry-after'),'12');assert.equal(payload.error.retryAfterSeconds,12);assert.equal(calls.length,before+1);
  });
} finally {
  if(channelId)await api(`/api/channels/${channelId}`,{method:'DELETE'});
  upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));
  await writeFile(new URL('./rate-limit-integration-result.json',import.meta.url),JSON.stringify({verifiedAt:new Date().toISOString(),passed:checks.length,checks},null,2));
}
console.log(`Rate limit integration complete: ${checks.length} checks passed.`);
