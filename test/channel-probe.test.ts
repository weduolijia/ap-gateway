import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../src/index';
import { DEFAULT_SETTINGS, validateChannel } from '../src/config';
import { Store } from '../src/store';
import { AuthService } from '../src/auth';
import { sessionCsrf } from '../src/access';
import { discoverModels } from '../src/gateway';
import type { Bindings } from '../src/types';

const base = 'https://gateway.example.com';
const token = 'a'.repeat(64);
const environment = { DB: {}, AUTH_ENABLED: 'true', APP_ENV: 'cloud-test' } as Bindings;
const openEnvironment = { DB: {}, AUTH_ENABLED: 'false', APP_ENV: 'local' } as Bindings;
const modelList = (ids: string[]) => Response.json({ data: ids.map(id => ({ id })) });

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function setup(fetchImpl: ReturnType<typeof vi.fn>) {
  vi.spyOn(Store.prototype, 'channel').mockResolvedValue(null);
  vi.spyOn(Store.prototype, 'settings').mockResolvedValue(DEFAULT_SETTINGS);
  vi.spyOn(Store.prototype, 'cachedProtocol').mockResolvedValue(undefined);
  vi.spyOn(AuthService.prototype, 'checkSession').mockResolvedValue({ expiresAt: new Date(Date.now() + 10000).toISOString(), version: 1 });
  const selection = vi.spyOn(Store.prototype, 'selectApiKey');
  vi.stubGlobal('fetch', fetchImpl);
  const request = async (body: unknown) => app.fetch(new Request(`${base}/api/channels/probe`, { method: 'POST', headers: { cookie: `__Host-ap_session=${token}`, 'x-csrf-token': await sessionCsrf(token), 'content-type': 'application/json' }, body: JSON.stringify(body) }), environment);
  return { request, selection };
}

const draft = { name: 'Draft', baseUrl: 'https://api.example.com/v1', apiKeys: ['draft-key'], protocol: 'openai', models: [] };

describe('draft channel probe', () => {
  it('queries an unsaved draft with the form values and does not touch key rotation', async () => {
    vi.spyOn(Store.prototype, 'channel').mockResolvedValue(null);
    vi.spyOn(Store.prototype, 'settings').mockResolvedValue(DEFAULT_SETTINGS);
    vi.spyOn(AuthService.prototype, 'checkSession').mockResolvedValue({ expiresAt: new Date(Date.now() + 10000).toISOString(), version: 1 });
    const fetcher = vi.fn(async () => modelList(['model-a', 'model-b']));
    vi.stubGlobal('fetch', fetcher);
    const selection = vi.spyOn(Store.prototype, 'selectApiKey');
    const response = await app.fetch(new Request(`${base}/api/channels/probe`, { method: 'POST', headers: { cookie: `__Host-ap_session=${token}`, 'x-csrf-token': await sessionCsrf(token), 'content-type': 'application/json' }, body: JSON.stringify({ ...draft, apiKeys: ['draft-key'] }) }), environment);
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ models: ['model-a', 'model-b'], saved: false, keyIndex: 1, keyCount: 1 });
    expect(selection).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example.com/v1/models');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer draft-key');
  });
  it('rejects an invalid draft before any upstream call', async () => {
    const fetcher = vi.fn();
    const { request } = setup(fetcher);
    const response = await request({ ...draft, baseUrl: 'ftp://example.com' });
    expect(response.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('uses saved channel metadata only through the explicit channelId, never the URL id', async () => {
    const fetcher = vi.fn(async () => modelList(['model-a']));
    const { request } = setup(fetcher);
    const saved = validateChannel({ name: 'Saved', baseUrl: 'https://other.example.com', apiKeys: ['saved-key'], protocol: 'openai', models: [] }, environment);
    vi.spyOn(Store.prototype, 'channel').mockResolvedValue(saved);
    const response = await request({ ...draft, channelId: saved.id });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ saved: true, keyCount: 1 });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example.com/v1/models');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer draft-key');
  });
  it('requires authentication like the other channel routes', async () => {
    const response = await app.fetch(new Request(`${base}/api/channels/probe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(draft) }), environment);
    expect(response.status).toBe(401);
  });
});

describe('model list replacement', () => {
  it('replaces the stored model list instead of merging when saving probe results', async () => {
    const channel = validateChannel({ name: 'Saved', baseUrl: 'https://api.example.com', apiKeys: ['k'], protocol: 'openai', models: ['old-model', 'shared-model'] }, environment);
    const save = vi.spyOn(Store.prototype, 'saveChannel').mockResolvedValue();
    vi.spyOn(Store.prototype, 'channel').mockResolvedValue(channel);
    vi.spyOn(Store.prototype, 'settings').mockResolvedValue(DEFAULT_SETTINGS);
    vi.spyOn(Store.prototype, 'cachedProtocol').mockResolvedValue(undefined);
    vi.spyOn(AuthService.prototype, 'checkSession').mockResolvedValue({ expiresAt: new Date(Date.now() + 10000).toISOString(), version: 1 });
    vi.stubGlobal('fetch', vi.fn(async () => modelList(['shared-model', 'new-model'])));
    const response = await app.fetch(new Request(`${base}/api/channels/${channel.id}`, { method: 'PUT', headers: { cookie: `__Host-ap_session=${token}`, 'x-csrf-token': await sessionCsrf(token), 'content-type': 'application/json' }, body: JSON.stringify({ models: ['shared-model', 'new-model'] }) }), environment);
    expect(response.status).toBe(200);
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0][0].models).toEqual(['shared-model', 'new-model']);
  });
  it('keeps discoverModels rotation behaviour for saved channels', async () => {
    const channel = validateChannel({ name: 'Saved', baseUrl: 'https://api.example.com', apiKeys: ['k1', 'k2'], protocol: 'openai', models: [] }, environment);
    const selection = vi.spyOn(Store.prototype, 'selectApiKey').mockResolvedValue({ apiKey: 'k2', keyIndex: 2, keyCount: 2 });
    vi.stubGlobal('fetch', vi.fn(async () => modelList(['m'])));
    const store = new Store({} as D1Database);
    expect(await discoverModels(channel, store)).toMatchObject({ models: ['m'], keyIndex: 2, keyCount: 2 });
    expect(selection).toHaveBeenCalledOnce();
  });
});
