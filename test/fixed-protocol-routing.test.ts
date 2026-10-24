import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, DEMO_CHANNEL } from '../src/config';
import { candidateProtocols, gateway } from '../src/gateway';
import { Store } from '../src/store';
import type { Bindings, Channel, Protocol, RequestLog } from '../src/types';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const fixed = { ...DEMO_CHANNEL, protocol: 'responses' as const };
describe('fixed upstream protocol selection', () => {
  it.each([null, 'auto', 'openai', 'anthropic', 'gemini', 'responses'])('channel protocol wins over request override %s and cached protocol', override => {
    expect(candidateProtocols(fixed, 'openai', override, 'openai')).toEqual(['responses']);
  });
  it('automatic channels retain client override and negotiation support', () => {
    expect(candidateProtocols(DEMO_CHANNEL, 'openai', 'responses', 'openai')).toEqual(['responses']);
    expect(candidateProtocols(DEMO_CHANNEL, 'responses', null, 'anthropic')).toEqual(['anthropic', 'responses', 'openai', 'gemini']);
  });
});

function setup(protocol: Protocol = 'responses') {
  const channel: Channel = { ...DEMO_CHANNEL, id: 'fixed', name: 'Fixed upstream', baseUrl: 'https://example.com', isDemo: false, protocol, apiKeys: ['upstream-secret'] };
  const logs: RequestLog[] = [];
  const pending: Promise<unknown>[] = [];
  vi.spyOn(Store.prototype, 'channels').mockResolvedValue([channel]);
  vi.spyOn(Store.prototype, 'settings').mockResolvedValue({ ...DEFAULT_SETTINGS, defaultChannelId: channel.id });
  vi.spyOn(Store.prototype, 'cachedProtocol').mockResolvedValue('openai');
  vi.spyOn(Store.prototype, 'cacheProtocol').mockResolvedValue();
  vi.spyOn(Store.prototype, 'selectApiKey').mockResolvedValue({ apiKey: 'upstream-secret', keyIndex: 1, keyCount: 1 });
  vi.spyOn(Store.prototype, 'log').mockImplementation(async log => { logs.push(log); });
  const fetcher = vi.fn().mockResolvedValue(Response.json({ id: 'resp_result', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'converted', annotations: [] }] }] }));
  vi.stubGlobal('fetch', fetcher);
  const run = (body: any, override?: string) => gateway(new Request('http://localhost/v1/chat/completions', { headers: override ? { 'x-ap-protocol': override } : {} }), { DB: {} } as Bindings, { waitUntil(promise) { pending.push(promise); } }, 'openai', body, 'client-model', false);
  return { run, logs, pending, fetcher };
}

describe('conversion and routing diagnostics', () => {
  it('translates a metadata-bearing Chat request to Responses and replies in Chat format', async () => {
    const { run, logs, pending, fetcher } = setup();
    const response = await run({ messages: [{ role: 'user', content: 'hello' }], metadata: { client: 'test' }, user: 'user-1', frequency_penalty: 0, presence_penalty: 0, logprobs: false, n: 1 }, 'auto');
    expect(response.status).toBe(200);
    expect(fetcher.mock.calls[0][0]).toBe('https://example.com/v1/responses');
    const body = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(body.input).toBeDefined();
    expect(body.messages).toBeUndefined();
    expect(body.metadata).toEqual({ client: 'test' });
    expect((await response.json()).choices[0].message.content).toBe('converted');
    expect(response.headers.get('x-ap-protocol')).toBe('responses');
    expect(response.headers.get('x-ap-incoming-protocol')).toBe('openai');
    expect(response.headers.get('x-ap-forwarded')).toBe('true');
    await Promise.all(pending);
    expect(logs[0]).toMatchObject({ incomingProtocol: 'openai', upstreamProtocol: 'responses', attempts: 1, outcome: 'ok' });
  });
  it('reports the intended upstream and no forwarding when conversion cannot preserve input', async () => {
    const { run, logs, pending, fetcher } = setup();
    let failure: any;
    try { await run({ messages: [], n: 2 }); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: 'unsupported_protocol_conversion', status: 400 });
    expect(failure.headers.get('x-ap-protocol')).toBe('responses');
    expect(failure.headers.get('x-ap-forwarded')).toBe('false');
    expect(failure.headers.get('x-ap-attempts')).toBe('0');
    expect(fetcher).not.toHaveBeenCalled();
    await Promise.all(pending);
    expect(logs[0]).toMatchObject({ upstreamProtocol: 'responses', attempts: 0, error: 'unsupported_protocol_conversion' });
    expect(logs[0].errorMessage).toContain('n=1');
  });
  it('does not fall back to Chat when a fixed Responses endpoint rejects the request', async () => {
    const { run, logs, pending, fetcher } = setup();
    fetcher.mockResolvedValue(Response.json({ error: { code: 'endpoint_not_found' } }, { status: 404 }));
    await expect(run({ messages: [{ role: 'user', content: 'hello' }] }, 'openai')).rejects.toMatchObject({ code: 'upstream_error', status: 404 });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][0]).toBe('https://example.com/v1/responses');
    await Promise.all(pending);
    expect(logs[0].upstreamProtocol).toBe('responses');
  });
});
