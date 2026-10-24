import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../src/index';
import { DEFAULT_SETTINGS, validateChannel } from '../src/config';
import { parseRetryAfter, responseHeaders, sanitizeUpstreamText } from '../src/headers';
import { Store } from '../src/store';
import type { Bindings, RequestLog } from '../src/types';

const internError = { error: { code: 'rate_limit_exceeded', type: 'rate_limit_exceeded', message: 'Channel rate limit reached for model' } };
const now = Date.parse('2026-10-23T00:00:00Z');

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function setup(payload: unknown = internError, headers: Record<string, string> = {}, status = 429) {
  const channel = { ...validateChannel({ name: 'Intern', baseUrl: 'https://example.com', apiKeys: ['first-secret', 'second-secret', 'third-secret'], protocols: ['responses', 'openai', 'gemini'], models: ['intern-model'] }, {}), id: 'intern', apiKey: 'legacy-secret' };
  const logs: RequestLog[] = [];
  const pending: Promise<unknown>[] = [];
  vi.spyOn(Store.prototype, 'channels').mockResolvedValue([channel, { ...channel, id: 'other', apiKeys: ['other-channel-secret'] }]);
  vi.spyOn(Store.prototype, 'channel').mockResolvedValue(channel);
  vi.spyOn(Store.prototype, 'settings').mockResolvedValue({ ...DEFAULT_SETTINGS, defaultChannelId: channel.id });
  vi.spyOn(Store.prototype, 'cachedProtocol').mockResolvedValue(undefined);
  vi.spyOn(Store.prototype, 'log').mockImplementation(async log => { logs.push(log); });
  const selection = vi.spyOn(Store.prototype, 'selectApiKey').mockResolvedValue({ apiKey: 'second-secret', keyIndex: 2, keyCount: 3 });
  const fetcher = vi.fn().mockImplementation(async () => Response.json(payload, { status, headers }));
  vi.stubGlobal('fetch', fetcher);
  const run = (path = '/v1/responses') => app.fetch(new Request(`http://localhost${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer client-secret' }, body: JSON.stringify({ model: 'intern-model', input: 'hello' }) }), { DB: {}, APP_ENV: 'local' } as Bindings, { waitUntil(promise: Promise<unknown>) { pending.push(promise); }, passThroughOnException() {} } as ExecutionContext);
  return { run, logs, pending, fetcher, selection };
}

describe('429 diagnostics', () => {
  it('preserves the Intern reason without inventing a retry delay or retrying', async () => {
    const { run, logs, pending, fetcher, selection } = setup();
    const response = await run();
    await Promise.all(pending);
    const result = await response.json();
    expect(response.status).toBe(429);
    expect(result.error).toMatchObject({ type: 'upstream_error', upstreamCode: 'rate_limit_exceeded', upstreamMessage: 'Channel rate limit reached for model' });
    expect(result.error.message).toContain('上游限流');
    expect(result.error).not.toHaveProperty('retryAfterSeconds');
    expect(response.headers.has('retry-after')).toBe(false);
    expect(response.headers.get('x-ap-request-id')).toBe(logs[0].id);
    expect(response.headers.get('x-ap-channel')).toBe('intern');
    expect(response.headers.get('x-ap-protocol')).toBe('responses');
    expect(response.headers.get('x-ap-attempts')).toBe('1');
    expect(response.headers.get('x-ap-key-index')).toBe('2');
    expect(logs[0]).toMatchObject({ status: 429, attempts: 1, keyIndex: 2, keyCount: 3, outcome: 'error', error: 'upstream_error', upstreamCode: 'rate_limit_exceeded', upstreamMessage: 'Channel rate limit reached for model' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(selection).toHaveBeenCalledTimes(1);
  });

  it('keeps quota codes distinct and passes a valid delay and rate headers', async () => {
    const { run, logs } = setup({ error: { code: 'quota_exceeded', message: 'Monthly quota exhausted' } }, { 'retry-after': '90', 'x-ratelimit-limit-requests': '20', 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '90s', 'x-ratelimit-remaining-tokens': '0', 'ratelimit-reset': '90', 'anthropic-ratelimit-requests-reset': '2026-10-23T00:01:30Z', 'x-request-id': 'upstream-request-7' });
    const response = await run();
    expect((await response.json()).error).toMatchObject({ upstreamCode: 'quota_exceeded', retryAfterSeconds: 90 });
    expect(logs[0]).toMatchObject({ upstreamCode: 'quota_exceeded', retryAfterSeconds: 90 });
    expect(response.headers.get('retry-after')).toBe('90');
    expect(response.headers.get('x-ratelimit-remaining-requests')).toBe('0');
    expect(response.headers.get('x-ratelimit-reset-requests')).toBe('90s');
    expect(response.headers.get('x-ratelimit-remaining-tokens')).toBe('0');
    expect(response.headers.get('ratelimit-reset')).toBe('90');
    expect(response.headers.get('anthropic-ratelimit-requests-reset')).toBe('2026-10-23T00:01:30Z');
    expect(response.headers.get('x-request-id')).toBe('upstream-request-7');
  });

  it('preserves a valid HTTP date and reports its remaining seconds', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const { run } = setup(internError, { 'retry-after': 'Fri, 23 Oct 2026 00:02:00 GMT' });
    const response = await run();
    expect(response.headers.get('retry-after')).toBe('Fri, 23 Oct 2026 00:02:00 GMT');
    expect((await response.json()).error.retryAfterSeconds).toBe(120);
  });

  it('removes configured and client credentials, control characters and unsafe headers', async () => {
    const message = 'first-secret second-secret third-secret legacy-secret other-channel-secret client-secret Bearer unknown-credential api_key="hidden token" sk-provider-key user@example.com \u0000\u001blimited';
    const { run, logs } = setup({ error: { code: 'second-secret', message } }, { 'x-request-id': 'third-secret', 'x-ratelimit-reset-requests': 'Bearer header-secret', 'x-ratelimit-leaked-secret': 'first-secret', 'ratelimit-limit': 'password=hidden-header', 'x-ratelimit-limit-tokens': '2'.repeat(257), 'retry-after': 'Bearer another-secret' });
    const response = await run();
    const result = await response.json();
    const output = JSON.stringify({ result, logs, headers: [...response.headers] });
    for (const secret of ['first-secret', 'second-secret', 'third-secret', 'legacy-secret', 'other-channel-secret', 'client-secret', 'unknown-credential', 'hidden token', 'sk-provider-key', 'user@example.com', 'header-secret', 'hidden-header']) expect(output).not.toContain(secret);
    expect(result.error.upstreamMessage).toContain('[REDACTED]');
    expect(result.error.upstreamMessage).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(result.error).not.toHaveProperty('upstreamCode');
    expect(result.error).not.toHaveProperty('retryAfterSeconds');
    for (const name of ['x-request-id', 'x-ratelimit-reset-requests', 'x-ratelimit-leaked-secret', 'ratelimit-limit', 'x-ratelimit-limit-tokens', 'retry-after']) expect(response.headers.has(name)).toBe(false);
  });

  it.each([null, ['sensitive object'], { error: { code: { secret: 'never-serialize' }, message: { secret: 'never-serialize' } } }])('does not serialize unrecognized upstream error objects %#', async payload => {
    const { run } = setup(payload);
    const response = await run();
    const result = await response.json();
    expect(response.status).toBe(429);
    expect(result.error).not.toHaveProperty('upstreamCode');
    expect(result.error).not.toHaveProperty('upstreamMessage');
    expect(JSON.stringify(result)).not.toContain('never-serialize');
  });

  it('keeps malformed or oversized upstream 429 bodies as HTTP 429', async () => {
    const { run, fetcher } = setup();
    fetcher.mockResolvedValueOnce(new Response('<html>private debug page</html>', { status: 429 })).mockResolvedValueOnce(Response.json({ error: { message: 'x'.repeat(65536) } }, { status: 429 }));
    for (let index = 0; index < 2; index++) {
      const response = await run();
      expect(response.status).toBe(429);
      expect((await response.json()).error).not.toHaveProperty('upstreamMessage');
    }
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('preserves 429 diagnostics on model discovery with one key and endpoint attempt', async () => {
    const { run, fetcher, selection } = setup(internError, { 'retry-after': '60', 'x-ratelimit-remaining-requests': '0' });
    const response = await run('/api/channels/intern/probe');
    expect(response.status).toBe(429);
    expect((await response.json()).error).toMatchObject({ type: 'probe_failed', upstreamCode: 'rate_limit_exceeded', upstreamMessage: 'Channel rate limit reached for model', retryAfterSeconds: 60 });
    expect(response.headers.get('retry-after')).toBe('60');
    expect(response.headers.get('x-ratelimit-remaining-requests')).toBe('0');
    expect(response.headers.get('x-ap-request-id')).toBeTruthy();
    expect(response.headers.get('x-ap-channel')).toBe('intern');
    expect(response.headers.get('x-ap-key-index')).toBe('2');
    expect(response.headers.get('x-ap-attempts')).toBe('1');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(selection).toHaveBeenCalledTimes(1);
  });
});

describe('non-429 upstream diagnostics', () => {
  const rejected = { error: { type: 'invalid_request_error', code: 'invalid_value', message: 'Upstream rejected the request as invalid [trace_id=038efdd6c1a97b23714488cea56c3070]' } };

  it('surfaces the upstream reason and trace id for a 400 instead of a generic message', async () => {
    const { run, logs, pending } = setup(rejected, { 'retry-after': '30' }, 400);
    const response = await run();
    await Promise.all(pending);
    const result = await response.json();
    expect(response.status).toBe(400);
    expect(result.error.message).toContain('Upstream rejected the request as invalid');
    expect(result.error.message).toContain('[trace_id=038efdd6c1a97b23714488cea56c3070]');
    expect(result.error).toMatchObject({ type: 'upstream_error', upstreamCode: 'invalid_value', upstreamMessage: rejected.error.message });
    expect(result.error).not.toHaveProperty('retryAfterSeconds');
    expect(logs[0]).toMatchObject({ status: 400, outcome: 'error', error: 'upstream_error', upstreamCode: 'invalid_value', upstreamMessage: rejected.error.message, errorMessage: rejected.error.message });
    expect(logs[0]).not.toHaveProperty('retryAfterSeconds');
  });

  it('keeps the operator hint when the upstream body carries no message', async () => {
    const { run } = setup({}, {}, 502);
    const result = await (await run()).json();
    expect(result.error.message).toBe('上游 502；请检查渠道协议、模型及上游密钥');
    expect(result.error).not.toHaveProperty('upstreamMessage');
    expect(result.error).not.toHaveProperty('upstreamCode');
  });

  it('redacts credentials in a non-429 upstream message before exposing it', async () => {
    const message = 'invalid api_key client-secret for second-secret';
    const { run, logs } = setup({ error: { message } }, {}, 400);
    const result = await (await run()).json();
    expect(result.error.upstreamMessage).toContain('[REDACTED]');
    expect(JSON.stringify({ result, logs })).not.toContain('client-secret');
    expect(JSON.stringify({ result, logs })).not.toContain('second-secret');
  });

  it('reports a 200 body that only contains an error object with its reason', async () => {
    const { run } = setup({ error: { message: 'model gpt-6-astra is not available' } }, {}, 200);
    const response = await run();
    const result = await response.json();
    expect(response.status).toBe(502);
    expect(result.error.message).toContain('model gpt-6-astra is not available');
    expect(result.error.upstreamMessage).toBe('model gpt-6-astra is not available');
  });
});

describe('bounded diagnostic sanitizers', () => {
  it.each(['0', '1', '90', '31536000'])('accepts bounded integer Retry-After %s', value => {
    expect(parseRetryAfter(value, now)).toEqual({ value, seconds: Number(value) });
  });
  it.each([null, '', '-1', '1.5', '1e3', 'Infinity', 'NaN', '31536001', '9'.repeat(129), 'tomorrow', '2026-10-23T00:00:00Z', 'Fri, 30 Feb 2026 00:00:00 GMT', 'Sat, 24 Oct 2099 00:00:00 GMT'])('rejects invalid or unbounded Retry-After %s', value => {
    expect(parseRetryAfter(value, now)).toBeUndefined();
  });
  it('calculates valid HTTP dates, including already elapsed delays', () => {
    expect(parseRetryAfter('Fri, 23 Oct 2026 00:01:00 GMT', now)?.seconds).toBe(60);
    expect(parseRetryAfter('Thu, 22 Oct 2026 00:00:00 GMT', now)?.seconds).toBe(0);
  });
  it('redacts before truncating and never dumps objects', () => {
    const secret = 'private/'.repeat(70);
    const message = sanitizeUpstreamText(`${'x'.repeat(390)} ${secret} tail`, [secret]);
    expect(message!.length).toBeLessThanOrEqual(400);
    expect(message).not.toContain('private');
    expect(sanitizeUpstreamText({ secret }, [])).toBeUndefined();
    expect(sanitizeUpstreamText(encodeURIComponent(secret), [secret])).toBe('[REDACTED]');
  });
  it('drops values that contain secrets even under recognized header names', () => {
    const headers = responseHeaders(new Headers({ 'retry-after': '20', 'x-ratelimit-limit-requests': '20', 'request-id': 'safe-request' }), false, ['20']);
    expect(headers.has('retry-after')).toBe(false);
    expect(headers.has('x-ratelimit-limit-requests')).toBe(false);
    expect(headers.get('request-id')).toBe('safe-request');
  });
});
