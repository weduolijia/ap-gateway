import { afterEach, describe, expect, it, vi } from 'vitest';
import { channelApiKeys, DEFAULT_SETTINGS, publicChannel, validateChannel } from '../src/config';
import { discoverModels, gateway } from '../src/gateway';
import { upstreamHeaders } from '../src/headers';
import { Store } from '../src/store';
import type { Bindings, Channel, RequestLog } from '../src/types';

const environment = { APP_ENV: 'local', ALLOW_LOCAL_UPSTREAM: 'true' };
function channel(input: Record<string, unknown> = {}): Channel {
  return validateChannel({ name: 'Key pool', baseUrl: 'http://127.0.0.1:9999', apiKeys: ['first-secret', 'second-secret', 'third-secret'], ...input }, environment);
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('channel key pool configuration', () => {
  it('trims and deduplicates keys without changing their order', () => {
    expect(channel({ apiKeys: [' first-secret ', 'second-secret', 'first-secret'] }).apiKeys).toEqual(['first-secret', 'second-secret']);
  });
  it('preserves a pool on omitted or blank legacy input', () => {
    const saved = channel();
    for (const update of [{ name: 'Renamed' }, { apiKeys: undefined }, { apiKey: undefined }, { apiKey: '' }]) {
      expect(validateChannel(update, environment, saved).apiKeys).toEqual(saved.apiKeys);
    }
  });
  it('reads and preserves legacy saved single keys', () => {
    const saved = { ...channel(), apiKeys: undefined, apiKey: 'legacy-secret' };
    expect(channelApiKeys(saved)).toEqual(['legacy-secret']);
    expect(validateChannel({ apiKey: '' }, environment, saved).apiKeys).toEqual(['legacy-secret']);
    expect(publicChannel(saved)).toMatchObject({ hasApiKey: true, keyCount: 1 });
  });
  it('normalizes the legacy single-key input and replaces an existing pool', () => {
    const created = validateChannel({ name: 'Legacy', baseUrl: 'http://127.0.0.1:9999', apiKey: ' legacy-secret ' }, environment);
    expect(created.apiKeys).toEqual(['legacy-secret']);
    expect(validateChannel({ apiKey: 'replacement-secret' }, environment, channel()).apiKeys).toEqual(['replacement-secret']);
  });
  it.each([{ apiKeys: [] }, { apiKeys: null }, { apiKey: null }])('clears the entire pool with %j', update => {
    const cleared = validateChannel(update, environment, channel());
    expect(channelApiKeys(cleared)).toEqual([]);
    expect(publicChannel(cleared)).toMatchObject({ hasApiKey: false, keyCount: 0 });
  });
  it.each([{ apiKey: '', apiKeys: [] }, { apiKey: null, apiKeys: null }, { apiKey: 'secret', apiKeys: ['secret'] }])('rejects simultaneous credentials %j', update => {
    expect(() => validateChannel(update, environment, channel())).toThrow('不能同时');
  });
  it.each(['secret', {}, [null], [1], [''], ['   '], ['key\nvalue'], ['key\0value'], ['非 HTTP 字符'], ['x'.repeat(8193)], Array(101).fill('secret')])('rejects invalid key input %# without echoing credentials', apiKeys => {
    expect(() => channel({ apiKeys })).toThrow();
    try { channel({ apiKeys }); } catch (error) { expect(String(error)).not.toContain('key\nvalue'); }
  });
  it('allows 100 keys and replaces the complete pool', () => {
    expect(channel({ apiKeys: Array.from({ length: 100 }, (_, index) => `key-${index}`) }).apiKeys).toHaveLength(100);
    expect(validateChannel({ apiKeys: ['new-secret'] }, environment, channel()).apiKeys).toEqual(['new-secret']);
  });
  it('strips both credential fields and recomputes public metadata', () => {
    const output = publicChannel({ ...channel(), apiKey: 'legacy-secret', hasApiKey: false, keyCount: 999 });
    expect(output).not.toHaveProperty('apiKey');
    expect(output).not.toHaveProperty('apiKeys');
    expect(output).toMatchObject({ hasApiKey: true, keyCount: 3 });
    for (const key of ['legacy-secret', 'first-secret', 'second-secret', 'third-secret']) expect(JSON.stringify(output)).not.toContain(key);
  });
});

describe('persistent key selection contract', () => {
  it('avoids database writes for zero keys, one key, and legacy keys', async () => {
    const prepare = vi.fn();
    const store = new Store({ prepare } as unknown as D1Database);
    expect(await store.selectApiKey(channel({ apiKeys: [] }))).toEqual({ apiKey: undefined, keyIndex: null, keyCount: 0 });
    expect(await store.selectApiKey(channel({ apiKeys: ['only-secret'] }))).toEqual({ apiKey: 'only-secret', keyIndex: 1, keyCount: 1 });
    expect(await store.selectApiKey({ ...channel(), apiKeys: undefined, apiKey: 'legacy-secret' })).toEqual({ apiKey: 'legacy-secret', keyIndex: 1, keyCount: 1 });
    expect(prepare).not.toHaveBeenCalled();
  });
  it('uses the atomic database result as a one-based key index', async () => {
    const first = vi.fn().mockResolvedValue({ key_index: 2 });
    const bind = vi.fn().mockReturnValue({ first });
    const prepare = vi.fn().mockReturnValue({ bind });
    const store = new Store({ prepare } as unknown as D1Database);
    expect(await store.selectApiKey(channel())).toEqual({ apiKey: 'third-secret', keyIndex: 3, keyCount: 3 });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledTimes(1);
  });
  it('fails before selecting a key if the configuration changed', async () => {
    const first = vi.fn().mockResolvedValue(null);
    const bind = vi.fn().mockReturnValue({ first });
    const store = new Store({ prepare: vi.fn().mockReturnValue({ bind }) } as unknown as D1Database);
    await expect(store.selectApiKey(channel())).rejects.toMatchObject({ status: 409, code: 'channel_conflict' });
  });
});

describe('selected key authentication', () => {
  it.each([['openai', 'authorization', 'Bearer second-secret'], ['responses', 'authorization', 'Bearer second-secret'], ['anthropic', 'x-api-key', 'second-secret'], ['gemini', 'x-goog-api-key', 'second-secret']] as const)('uses the selected key for %s', (protocol, name, value) => {
    const headers = upstreamHeaders(new Headers({ authorization: 'Bearer client-secret' }), channel(), protocol, 'passthrough', false, 'second-secret');
    expect(headers.get(name)).toBe(value);
  });
  it('keeps incoming-key passthrough when a channel has no configured keys', () => {
    const headers = upstreamHeaders(new Headers({ authorization: 'Bearer client-secret' }), channel({ apiKeys: [] }), 'anthropic', 'passthrough', false);
    expect(headers.get('x-api-key')).toBe('client-secret');
  });
});

describe('one selection per gateway request', () => {
  function setup() {
    const saved = channel({ protocols: ['responses', 'openai'], models: ['test-model'] });
    const logs: RequestLog[] = [];
    const pending: Promise<unknown>[] = [];
    vi.spyOn(Store.prototype, 'channels').mockResolvedValue([saved]);
    vi.spyOn(Store.prototype, 'settings').mockResolvedValue({ ...DEFAULT_SETTINGS, defaultChannelId: saved.id });
    vi.spyOn(Store.prototype, 'cachedProtocol').mockResolvedValue(undefined);
    vi.spyOn(Store.prototype, 'cacheProtocol').mockResolvedValue();
    vi.spyOn(Store.prototype, 'log').mockImplementation(async log => { logs.push(log); });
    const select = vi.spyOn(Store.prototype, 'selectApiKey').mockResolvedValue({ apiKey: 'second-secret', keyIndex: 2, keyCount: 3 });
    const run = () => gateway(new Request('http://localhost/v1/responses'), { DB: {} } as Bindings, { waitUntil(promise) { pending.push(promise); } }, 'responses', { model: 'test-model', input: 'hello' }, 'test-model', false);
    return { select, run, logs, pending };
  }
  it('keeps its key during protocol fallback and logs only its index', async () => {
    const { select, run, logs, pending } = setup();
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ error: { code: 'endpoint_not_found' } }, { status: 404 })).mockResolvedValueOnce(Response.json({ id: 'response', choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }] }));
    vi.stubGlobal('fetch', fetcher);
    const response = await run();
    await Promise.all(pending);
    expect(select).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const call of fetcher.mock.calls) expect(call[1].headers.get('authorization')).toBe('Bearer second-secret');
    expect(response.headers.get('x-ap-key-index')).toBe('2');
    expect(logs[0]).toMatchObject({ keyIndex: 2, keyCount: 3, attempts: 2, outcome: 'ok' });
    expect(JSON.stringify(logs)).not.toContain('secret');
  });
  it.each([401, 429, 500])('does not change keys or retry HTTP %i', async status => {
    const { select, run, logs, pending } = setup();
    const fetcher = vi.fn().mockResolvedValue(Response.json({ error: { code: 'second-secret', message: 'second-secret' } }, { status }));
    vi.stubGlobal('fetch', fetcher);
    await expect(run()).rejects.toMatchObject({ status, code: 'upstream_error' });
    await Promise.all(pending);
    expect(select).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(logs[0]).toMatchObject({ keyIndex: 2, keyCount: 3, attempts: 1, outcome: 'error' });
    expect(JSON.stringify(logs)).not.toContain('secret');
  });
});

describe('one selection per model discovery', () => {
  function setup() {
    const store = new Store({} as D1Database);
    const select = vi.spyOn(store, 'selectApiKey').mockResolvedValue({ apiKey: 'second-secret', keyIndex: 2, keyCount: 3 });
    return { store, select, saved: channel({ protocols: ['openai', 'gemini'] }) };
  }
  it('keeps the selected key while checking another models endpoint', async () => {
    const { store, select, saved } = setup();
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 404 })).mockResolvedValueOnce(Response.json({ models: [{ name: 'models/test-model' }] }));
    vi.stubGlobal('fetch', fetcher);
    expect(await discoverModels(saved, store)).toMatchObject({ models: ['test-model'], keyIndex: 2, keyCount: 3 });
    expect(select).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1].headers.get('authorization')).toBe('Bearer second-secret');
    expect(fetcher.mock.calls[1][1].headers.get('x-goog-api-key')).toBe('second-secret');
  });
  it.each([401, 429])('does not retry a discovery failure HTTP %i', async status => {
    const { store, select, saved } = setup();
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status }));
    vi.stubGlobal('fetch', fetcher);
    await expect(discoverModels(saved, store)).rejects.toMatchObject({ code: 'probe_failed' });
    expect(select).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
