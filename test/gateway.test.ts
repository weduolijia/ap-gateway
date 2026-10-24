import { describe, expect, it } from 'vitest';
import { candidateProtocols, channelServesModel, isProtocolMismatch, limitedJson, selectChannel, upstreamUrl } from '../src/gateway';
import { DEMO_CHANNEL, publicChannel, validateChannel, validateHeaders } from '../src/config';
import { upstreamHeaders } from '../src/headers';

describe('protocol routing', () => {
  it('keeps cached and incoming protocols ahead of other allowed candidates', () => {
    expect(candidateProtocols(DEMO_CHANNEL, 'responses', null, 'anthropic')).toEqual(['anthropic', 'responses', 'openai', 'gemini']);
    expect(candidateProtocols(DEMO_CHANNEL, 'responses', 'gemini')).toEqual(['gemini']);
    expect(() => candidateProtocols(DEMO_CHANNEL, 'responses', 'invalid')).toThrow();
  });
  it('normalizes version suffixes and custom upstream prefixes', () => {
    expect(upstreamUrl('https://example.com/proxy/v1/', 'responses')).toBe('https://example.com/proxy/v1/responses');
    expect(upstreamUrl('https://example.com/proxy/v1beta', 'gemini', 'model', true)).toBe('https://example.com/proxy/v1beta/models/model:streamGenerateContent?alt=sse');
  });
  it('retries explicit unsupported endpoints, not ambiguous failures', () => {
    expect(isProtocolMismatch(404, { error: { code: 'endpoint_not_found' } })).toBe(true);
    expect(isProtocolMismatch(404, { error: { message: 'Cannot POST /v1/responses' } })).toBe(true);
    expect(isProtocolMismatch(404, { error: { type: 'not_found', message: 'Model unavailable' } })).toBe(false);
    expect(isProtocolMismatch(404, {})).toBe(false);
    expect(isProtocolMismatch(404, null)).toBe(false);
    for (const status of [401, 403, 429, 500, 502, 504]) expect(isProtocolMismatch(status, {})).toBe(false);
    for (const status of [405, 415, 501]) expect(isProtocolMismatch(status, {})).toBe(true);
  });
});

describe('headers and credentials', () => {
  it('preserves allowed client headers and applies preset/custom overrides', () => {
    const channel = { ...DEMO_CHANNEL, apiKey: 'upstream-secret', headers: { 'user-agent': 'custom-client', 'x-feature': 'enabled' } };
    const headers = upstreamHeaders(new Headers({ authorization: 'Bearer client-secret', cookie: 'private=1', 'x-ap-channel': 'private', 'x-client-feature': 'yes', connection: 'x-hop', 'x-hop': 'private' }), channel, 'responses', 'codex', true);
    expect(headers.get('authorization')).toBe('Bearer upstream-secret');
    expect(headers.get('user-agent')).toBe('custom-client');
    expect(headers.get('originator')).toBe('codex_cli_rs');
    expect(headers.get('x-client-feature')).toBe('yes');
    expect(headers.get('accept')).toBe('text/event-stream');
    for (const name of ['cookie', 'x-ap-channel', 'connection', 'x-hop']) expect(headers.has(name)).toBe(false);
  });
  it('uses each upstream authentication header', () => {
    const channel = { ...DEMO_CHANNEL, apiKey: 'upstream-secret' };
    expect(upstreamHeaders(new Headers(), channel, 'anthropic', 'claude-code', false).get('x-api-key')).toBe('upstream-secret');
    expect(upstreamHeaders(new Headers(), channel, 'gemini', 'passthrough', false).get('x-goog-api-key')).toBe('upstream-secret');
  });
  it('keeps existing secrets on blank updates and clears them explicitly', () => {
    const environment = { APP_ENV: 'local', ALLOW_LOCAL_UPSTREAM: 'true' };
    const channel = validateChannel({ name: 'test', baseUrl: 'http://127.0.0.1:9999', apiKey: 'secret' }, environment);
    expect(validateChannel({ name: 'renamed', apiKey: '' }, environment, channel).apiKeys).toEqual(['secret']);
    expect(validateChannel({ apiKey: null }, environment, channel).apiKeys).toEqual([]);
    expect(publicChannel(channel)).not.toHaveProperty('apiKey');
    expect(publicChannel(channel).hasApiKey).toBe(true);
  });
  it('rejects invalid and reserved custom headers before storing', () => {
    for (const headers of [{ authorization: 'secret' }, { host: 'example.com' }, { 'x-value': 'bad\nvalue' }, { 'user-agent': '中文' }]) expect(() => validateHeaders(headers)).toThrow();
  });
});

describe('bounded JSON reads', () => {
  it('cancels oversized responses', async () => {
    await expect(limitedJson(new Response('{"long":"value"}'), 4)).rejects.toMatchObject({ code: 'response_too_large' });
  });
  it('reports malformed JSON', async () => {
    await expect(limitedJson(new Response('<html>error</html>'))).rejects.toMatchObject({ code: 'invalid_upstream_response' });
  });
});

describe('gateway key channel binding', () => {
  const alpha: any = { ...DEMO_CHANNEL, id: 'alpha', name: 'Alpha', isDemo: false, models: ['a-1', 'a-2'], modelMap: { 'a-alias': 'a-2' } };
  const beta: any = { ...DEMO_CHANNEL, id: 'beta', name: 'Beta', isDemo: false, models: [], modelMap: {} };
  const channels = [DEMO_CHANNEL, alpha, beta];
  it('routes a bound key to its own channel and rejects models outside the channel', () => {
    expect(selectChannel(channels, null, 'beta', 'a-1', { channelId: 'alpha', models: null }).id).toBe('alpha');
    expect(() => selectChannel(channels, null, 'beta', 'b-1', { channelId: 'alpha', models: null })).toThrow(/不允许使用模型/);
  });
  it('rejects a client channel header that disagrees with the key binding', () => {
    expect(() => selectChannel(channels, 'beta', 'beta', 'a-1', { channelId: 'alpha', models: null })).toThrow(/已绑定到其他渠道/);
    expect(selectChannel(channels, 'alpha', 'beta', 'a-1', { channelId: 'alpha', models: null }).id).toBe('alpha');
  });
  it('rejects a bound channel that is missing or disabled', () => {
    const disabled = [{ ...alpha, enabled: false }, beta];
    expect(() => selectChannel(disabled, null, 'beta', 'a-1', { channelId: 'alpha', models: null })).toThrow(/绑定的渠道不存在或已停用/);
  });
  it('treats an empty channel model list as unrestricted and a filled list as a whitelist', () => {
    expect(channelServesModel(beta, 'anything')).toBe(true);
    expect(channelServesModel(alpha, 'a-alias')).toBe(true);
    expect(channelServesModel(alpha, 'other')).toBe(false);
  });
});
