import { describe, expect, it, vi } from 'vitest';
import { createParser } from 'eventsource-parser';
import { convertResponse, convertStream } from '../src/protocols';
import { monitorStream, type StreamResult } from '../src/streaming';
import { sanitizeUpstreamText } from '../src/headers';
import type { Protocol } from '../src/types';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const frame = (body: any, type?: string) => `${type ? `event: ${type}\r\n` : ''}data: ${JSON.stringify(body)}\r\n\r\n`;
const named = (type: string, body: any = {}) => frame({ type, ...body }, type);
const chat = (delta: any, finishReason: string | null = null) => frame({ id: 'result_1', created: 12345, choices: [{ index: 0, delta, finish_reason: finishReason }] });
function source(frames: string[], chunkSize = Infinity): ReadableStream<Uint8Array> {
  const bytes = encoder.encode(frames.join(''));
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) { controller.close(); return; }
      const end = Math.min(offset + chunkSize, bytes.length);
      controller.enqueue(bytes.slice(offset, end)); offset = end;
    },
  }, { highWaterMark: 0 });
}
async function collect(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  let text = '';
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return text + decoder.decode();
      text += decoder.decode(next.value, { stream: true });
    }
  } finally { reader.releaseLock(); }
}
function events(value: string): any[] {
  const parsed: any[] = [];
  const parser = createParser({ onEvent(event) { parsed.push(event.data === '[DONE]' ? '[DONE]' : JSON.parse(event.data)); } });
  parser.feed(value);
  return parsed;
}
const secret = 'sk-live-SECRET-1234567890';
const sanitize = (message: string) => sanitizeUpstreamText(message, [secret], 600) ?? '上游返回错误事件';
async function monitored(stream: ReadableStream<Uint8Array>, protocol: Protocol) {
  const complete = vi.fn<(result: StreamResult) => void>();
  const output = monitorStream(stream, protocol, { started: Date.now(), heartbeatMs: 1000, timeoutMs: 10000, abort: () => {}, sanitize, complete });
  return { text: await collect(output), complete };
}
const anthropicFrames = (stopReason: string) => [
  named('message_start', { message: { id: 'm', content: [], usage: { input_tokens: 3, output_tokens: 0 } } }),
  named('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
  named('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'answer' } }),
  named('content_block_stop', { index: 0 }),
  named('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 2 } }),
  named('message_stop'),
];

describe('stream error sanitization', () => {
  it('redacts provider error text in synthetic frames for both passthrough and conversion', async () => {
    const input = [named('error', { error: { type: 'invalid_request_error', message: `invalid key ${secret}` } })];
    const direct = await monitored(source(input), 'anthropic');
    expect(direct.text).not.toContain(secret);
    expect(direct.text).toContain('[REDACTED]');
    expect(direct.complete.mock.calls[0][0]).toMatchObject({ outcome: 'error', error: 'upstream_stream_error' });
    const converted = await monitored(convertStream(source(input), 'anthropic', 'openai', 'm'), 'openai');
    expect(converted.text).not.toContain(secret);
    expect(converted.text).toContain('[REDACTED]');
    expect(converted.complete.mock.calls[0][0]).toMatchObject({ outcome: 'error', error: 'unsupported_protocol_conversion' });
  });
});

describe('Anthropic terminal reasons', () => {
  for (const stop of ['model_context_window_exceeded', 'pause_turn']) {
    it(`maps ${stop} to a truncated result instead of a gateway error`, async () => {
      const body = { id: 'm', content: [{ type: 'text', text: 'answer' }], stop_reason: stop };
      expect(convertResponse(body, 'anthropic', 'openai', 'm').choices[0].finish_reason).toBe('length');
      expect(convertResponse(body, 'anthropic', 'responses', 'm')).toMatchObject({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } });
      const output = events(await collect(convertStream(source(anthropicFrames(stop)), 'anthropic', 'openai', 'm')));
      expect(output.find(event => event.choices?.[0]?.finish_reason)?.choices[0].finish_reason).toBe('length');
      expect(output.at(-1)).toBe('[DONE]');
    });
  }
});

describe('Gemini response metadata', () => {
  const body = { candidates: [{ content: { parts: [
    { text: 'internal thinking', thought: true, thoughtSignature: 'sig-think' },
    { text: 'answer', thoughtSignature: 'sig-answer' },
    { functionCall: { id: 'call_1', name: 'weather', args: { city: 'Paris' } }, thoughtSignature: 'sig-call' },
  ] }, finishReason: 'STOP' }] };
  it('skips thought parts and accepts signatures on text and function calls', () => {
    const openai = convertResponse(body, 'gemini', 'openai', 'm');
    expect(openai.choices[0].message.content).toBe('answer');
    expect(openai.choices[0].message.tool_calls).toEqual([{ id: 'call_1', type: 'function', function: { name: 'weather', arguments: '{"city":"Paris"}' } }]);
    const anthropic = convertResponse(body, 'gemini', 'anthropic', 'm');
    expect(anthropic.content.map((block: any) => block.type)).toEqual(['text', 'tool_use']);
    expect(anthropic.content[0].text).toBe('answer');
  });
  it('applies the same rules to streaming conversion', async () => {
    const input = [frame({ candidates: [{ content: { parts: [
      { text: 'internal thinking', thought: true },
      { text: 'answer', thoughtSignature: 'sig-answer' },
      { functionCall: { id: 'call_1', name: 'weather', args: { city: 'Paris' } }, thoughtSignature: 'sig-call' },
    ] }, finishReason: 'STOP' }] })];
    const output = events(await collect(convertStream(source(input), 'gemini', 'openai', 'm')));
    const text = output.map(event => event.choices?.[0]?.delta?.content ?? '').join('');
    const calls = output.flatMap(event => event.choices?.[0]?.delta?.tool_calls ?? []);
    expect(text).toBe('answer');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ id: 'call_1', function: { name: 'weather', arguments: '{"city":"Paris"}' } });
    expect(JSON.stringify(output)).not.toContain('internal thinking');
  });
});

describe('tool finish semantics', () => {
  const call = { id: 'call_1', type: 'function', function: { name: 'weather', arguments: '{"city":"Paris"}' } };
  it('treats stop with tool calls as tool_calls in non-stream conversion', () => {
    const body = { id: 'r', choices: [{ message: { role: 'assistant', tool_calls: [call] }, finish_reason: 'stop' }] };
    expect(convertResponse(body, 'openai', 'anthropic', 'm').stop_reason).toBe('tool_use');
    const responses = convertResponse(body, 'openai', 'responses', 'm');
    expect(responses.status).toBe('completed');
    expect(responses.output.map((item: any) => item.type)).toEqual(['function_call']);
  });
  it('converts legacy function_call responses and streams', async () => {
    const body = { id: 'r', choices: [{ message: { role: 'assistant', function_call: { name: 'weather', arguments: '{"city":"Paris"}' } }, finish_reason: 'function_call' }] };
    const anthropic = convertResponse(body, 'openai', 'anthropic', 'm');
    expect(anthropic.stop_reason).toBe('tool_use');
    expect(anthropic.content[0]).toMatchObject({ type: 'tool_use', name: 'weather', input: { city: 'Paris' } });
    expect(anthropic.content[0].id).toMatch(/^call_/);
    const responses = convertResponse(body, 'openai', 'responses', 'm');
    expect(responses.output.find((item: any) => item.type === 'function_call')).toMatchObject({ name: 'weather', arguments: '{"city":"Paris"}' });
    expect(responses.output.find((item: any) => item.type === 'function_call').call_id).toMatch(/^call_/);
    const input = [
      chat({ role: 'assistant', function_call: { name: 'weather', arguments: '' } }),
      chat({ function_call: { arguments: '{"city":"Paris"}' } }),
      chat({}, 'function_call'), 'data: [DONE]\r\n\r\n',
    ];
    const output = events(await collect(convertStream(source(input), 'openai', 'anthropic', 'm')));
    const start = output.find(event => event.type === 'content_block_start' && event.content_block?.type === 'tool_use');
    expect(start.content_block).toMatchObject({ name: 'weather' });
    expect(start.content_block.id).toMatch(/^call_/);
    const argumentsText = output.filter(event => event.type === 'content_block_delta').map(event => event.delta.partial_json).join('');
    expect(argumentsText).toBe('{"city":"Paris"}');
    expect(output.find(event => event.type === 'message_delta').delta.stop_reason).toBe('tool_use');
  });
  it('rejects mixing legacy function_call with modern tool_calls', async () => {
    expect(() => convertResponse({ choices: [{ message: { role: 'assistant', tool_calls: [call], function_call: { name: 'weather', arguments: '{}' } }, finish_reason: 'tool_calls' }] }, 'openai', 'anthropic', 'm')).toThrow(/both/);
    const input = [chat({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'weather', arguments: '{}' } }] }), chat({ function_call: { arguments: '{}' } }), 'data: [DONE]\r\n\r\n'];
    await expect(collect(convertStream(source(input), 'openai', 'anthropic', 'm'))).rejects.toThrow(/mix/);
  });
  it('accepts tool calls that omit the type field in both modes', async () => {
    const body = { choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'call_1', function: { name: 'weather', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] };
    expect(convertResponse(body, 'openai', 'anthropic', 'm').content[0]).toMatchObject({ type: 'tool_use', name: 'weather' });
    const input = [chat({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'weather', arguments: '{}' } }] }), chat({}, 'tool_calls'), 'data: [DONE]\r\n\r\n'];
    const output = events(await collect(convertStream(source(input), 'openai', 'anthropic', 'm')));
    expect(output.find(event => event.type === 'content_block_start').content_block).toMatchObject({ type: 'tool_use', id: 'call_1', name: 'weather' });
  });
});

describe('interleaved content ordering', () => {
  const body = { id: 'm', content: [
    { type: 'text', text: 'before' },
    { type: 'tool_use', id: 'call_1', name: 'weather', input: { city: 'Paris' } },
    { type: 'text', text: 'after' },
  ], stop_reason: 'tool_use' };
  it('keeps content before and after a tool call in Responses output', () => {
    const output = convertResponse(body, 'anthropic', 'responses', 'm');
    expect(output.output.map((item: any) => item.type)).toEqual(['message', 'function_call', 'message']);
    expect(output.output[0].content[0].text).toBe('before');
    expect(output.output[2].content[0].text).toBe('after');
    expect(output.output_text).toBe('beforeafter');
  });
  it('keeps block order when converting Responses back to Anthropic', () => {
    const response = { id: 'r', status: 'completed', output: [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'before', annotations: [] }] },
      { type: 'function_call', call_id: 'call_1', name: 'weather', arguments: '{}' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'after', annotations: [] }] },
    ] };
    expect(convertResponse(response, 'responses', 'anthropic', 'm').content.map((block: any) => block.type)).toEqual(['text', 'tool_use', 'text']);
  });
  it('preserves ordering in streaming conversion', async () => {
    const input = [
      named('message_start', { message: { id: 'm', content: [], usage: { input_tokens: 3, output_tokens: 0 } } }),
      named('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      named('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'before' } }),
      named('content_block_stop', { index: 0 }),
      named('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'call_1', name: 'weather', input: {} } }),
      named('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"city":"Paris"}' } }),
      named('content_block_stop', { index: 1 }),
      named('content_block_start', { index: 2, content_block: { type: 'text', text: '' } }),
      named('content_block_delta', { index: 2, delta: { type: 'text_delta', text: 'after' } }),
      named('content_block_stop', { index: 2 }),
      named('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 3 } }),
      named('message_stop'),
    ];
    const output = events(await collect(convertStream(source(input), 'anthropic', 'responses', 'm')));
    const completed = output.find(event => event.type === 'response.completed');
    expect(completed.response.output.map((item: any) => item.type)).toEqual(['message', 'function_call', 'message']);
    expect(completed.response.output[0].content[0].text).toBe('before');
    expect(completed.response.output[2].content[0].text).toBe('after');
    expect(completed.response.output_text).toBe('beforeafter');
    const added = output.filter(event => event.type === 'response.output_item.added').map(event => event.item.id);
    expect(new Set(added).size).toBe(added.length);
  });
  it('buffers text after a tool call when the target is Gemini', async () => {
    const input = [
      named('message_start', { message: { id: 'm', content: [], usage: { input_tokens: 3, output_tokens: 0 } } }),
      named('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      named('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'before' } }),
      named('content_block_stop', { index: 0 }),
      named('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'call_1', name: 'weather', input: {} } }),
      named('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"city":"Paris"}' } }),
      named('content_block_stop', { index: 1 }),
      named('content_block_start', { index: 2, content_block: { type: 'text', text: '' } }),
      named('content_block_delta', { index: 2, delta: { type: 'text_delta', text: 'after' } }),
      named('content_block_stop', { index: 2 }),
      named('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 3 } }),
      named('message_stop'),
    ];
    const output = events(await collect(convertStream(source(input), 'anthropic', 'gemini', 'm')));
    const parts = output.at(-1).candidates[0].content.parts;
    expect(parts.map((part: any) => part.functionCall ? 'call' : 'text')).toEqual(['call', 'text']);
    expect(parts[1].text).toBe('after');
  });
});

describe('Gemini streaming deduplication and late usage', () => {
  it('deduplicates repeated function calls and rejects changed arguments', async () => {
    const identical = [
      frame({ candidates: [{ content: { parts: [{ functionCall: { id: 'call_1', name: 'weather', args: { city: 'Paris' } } }] } }] }),
      frame({ candidates: [{ content: { parts: [{ functionCall: { id: 'call_1', name: 'weather', args: { city: 'Paris' } } }] }, finishReason: 'STOP' }] }),
    ];
    let output = events(await collect(convertStream(source(identical), 'gemini', 'openai', 'm')));
    let calls = output.flatMap(event => event.choices?.[0]?.delta?.tool_calls ?? []);
    expect(calls).toHaveLength(1);
    const conflicting = [
      frame({ candidates: [{ content: { parts: [{ functionCall: { id: 'call_1', name: 'weather', args: { city: 'Paris' } } }] } }] }),
      frame({ candidates: [{ content: { parts: [{ functionCall: { id: 'call_1', name: 'weather', args: { city: 'Berlin' } } }] }, finishReason: 'STOP' }] }),
    ];
    await expect(collect(convertStream(source(conflicting), 'gemini', 'openai', 'm'))).rejects.toThrow(/arguments changed/);
  });
  it('accepts an OpenAI usage-only chunk without choices', async () => {
    const input = [chat({ content: 'answer' }), chat({}, 'stop'), frame({ id: 'result_1', usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }), 'data: [DONE]\r\n\r\n'];
    const output = events(await collect(convertStream(source(input), 'openai', 'responses', 'm')));
    const completed = output.find(event => event.type === 'response.completed');
    expect(completed.response.usage).toMatchObject({ input_tokens: 5, output_tokens: 2, total_tokens: 7 });
  });
  it('still rejects a chunk with neither choices nor usage', async () => {
    await expect(collect(convertStream(source([frame({ id: 'empty' }), 'data: [DONE]\r\n\r\n']), 'openai', 'responses', 'm'))).rejects.toThrow(/neither choices nor usage/);
  });
});
