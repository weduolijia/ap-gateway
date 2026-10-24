import { afterEach, describe, expect, it, vi } from 'vitest';
import { createParser } from 'eventsource-parser';
import { convertStream, ProtocolConversionError } from '../src/protocols';
import { monitorStream, type StreamResult } from '../src/streaming';
import type { Protocol } from '../src/types';

const protocols: Protocol[] = ['openai', 'responses', 'anthropic', 'gemini'];
const content = 'Hello 世界';
const argumentsText = '{"city":"Paris"}';
const usage = { prompt_tokens: 25, completion_tokens: 6, total_tokens: 31 };
const encode = new TextEncoder();
const frame = (body: any, type?: string) => `${type ? `event: ${type}\r\n` : ''}data: ${JSON.stringify(body)}\r\n\r\n`;
const named = (type: string, body: any = {}) => frame({ type, ...body }, type);
const chat = (delta: any, finishReason: string | null = null) => frame({ id: 'result_1', created: 12345, choices: [{ index: 0, delta, finish_reason: finishReason }] });
const responseOutput = [
  { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: content, annotations: [] }] },
  { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'weather', arguments: argumentsText, status: 'completed' },
];
const sourceFrames: Record<Protocol, string[]> = {
  openai: [
    chat({ role: 'assistant', content: '' }), chat({ content: 'Hello ' }), chat({ content: '世界' }),
    chat({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'weather', arguments: '{"city":' } }] }),
    chat({ tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] }),
    chat({}, 'tool_calls'), frame({ choices: [], usage }), 'data: [DONE]\r\n\r\n',
  ],
  responses: [
    named('response.created', { response: { id: 'result_1', created_at: 12345, status: 'in_progress', output: [] } }),
    named('response.output_item.added', { output_index: 0, item: { ...responseOutput[0], content: [] } }),
    named('response.content_part.added', { output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }),
    named('response.output_text.delta', { output_index: 0, content_index: 0, delta: 'Hello ' }),
    named('response.output_text.delta', { output_index: 0, content_index: 0, delta: '世界' }),
    named('response.output_text.done', { output_index: 0, content_index: 0, text: content }),
    named('response.output_item.done', { output_index: 0, item: responseOutput[0] }),
    named('response.output_item.added', { output_index: 1, item: { ...responseOutput[1], arguments: '' } }),
    named('response.function_call_arguments.delta', { output_index: 1, delta: '{"city":' }),
    named('response.function_call_arguments.delta', { output_index: 1, delta: '"Paris"}' }),
    named('response.function_call_arguments.done', { output_index: 1, arguments: argumentsText }),
    named('response.output_item.done', { output_index: 1, item: responseOutput[1] }),
    named('response.completed', { response: { id: 'result_1', status: 'completed', output: responseOutput, usage: { input_tokens: 25, output_tokens: 6, total_tokens: 31 } } }),
  ],
  anthropic: [
    named('message_start', { message: { id: 'result_1', content: [], usage: { input_tokens: 25, output_tokens: 0 } } }),
    named('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    named('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Hello ' } }),
    named('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '世界' } }),
    named('content_block_stop', { index: 0 }),
    named('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'call_1', name: 'weather', input: {} } }),
    named('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"city":' } }),
    named('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '"Paris"}' } }),
    named('content_block_stop', { index: 1 }),
    named('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 6 } }),
    named('message_stop'),
  ],
  gemini: [
    frame({ responseId: 'result_1', candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'Hello ' }] } }] }),
    frame({ candidates: [{ content: { parts: [{ text: '世界' }] } }] }),
    frame({ candidates: [{ content: { parts: [{ functionCall: { id: 'call_1', name: 'weather', args: { city: 'Paris' } } }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 25, candidatesTokenCount: 6, totalTokenCount: 31 } }),
  ],
};
function source(frames: string[], chunkSize = Infinity, cancelled = () => {}): ReadableStream<Uint8Array> {
  const bytes = encode.encode(frames.join(''));
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) { controller.close(); return; }
      const end = Math.min(offset + chunkSize, bytes.length);
      controller.enqueue(bytes.slice(offset, end)); offset = end;
    },
    cancel: cancelled,
  }, { highWaterMark: 0 });
}
async function collect(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = '';
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return result + decoder.decode();
      result += decoder.decode(next.value, { stream: true });
    }
  } finally { reader.releaseLock(); }
}
function events(value: string): any[] {
  const parsed: any[] = [];
  const parser = createParser({ onEvent(event) { parsed.push(event.data === '[DONE]' ? '[DONE]' : JSON.parse(event.data)); } });
  parser.feed(value);
  return parsed;
}
function summary(data: any[], protocol: Protocol) {
  let text = '';
  const calls = new Map<number, any>();
  let tokens: any;
  let reason: any;
  if (protocol === 'responses') {
    const response = data.findLast(event => ['response.completed', 'response.incomplete'].includes(event.type))?.response;
    expect(response).toBeDefined();
    for (const item of response.output) {
      if (item.type === 'message') text += item.content.map((part: any) => part.text ?? '').join('');
      else calls.set(calls.size, { id: item.call_id, name: item.name, arguments: item.arguments });
    }
    tokens = [response.usage?.input_tokens, response.usage?.output_tokens, response.usage?.total_tokens];
    reason = response.status;
  } else for (const event of data) {
    if (protocol === 'openai') {
      const choice = event.choices?.[0];
      text += choice?.delta?.content ?? '';
      for (const call of choice?.delta?.tool_calls ?? []) {
        const previous = calls.get(call.index) ?? { id: '', name: '', arguments: '' };
        calls.set(call.index, { id: call.id ?? previous.id, name: previous.name + (call.function?.name ?? ''), arguments: previous.arguments + (call.function?.arguments ?? '') });
      }
      if (event.usage) tokens = [event.usage.prompt_tokens, event.usage.completion_tokens, event.usage.total_tokens];
      if (choice?.finish_reason) reason = choice.finish_reason;
    } else if (protocol === 'anthropic') {
      if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') calls.set(event.index, { id: event.content_block.id, name: event.content_block.name, arguments: '' });
      if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') text += event.delta.text;
        if (event.delta.type === 'input_json_delta') calls.get(event.index).arguments += event.delta.partial_json;
      }
      if (event.type === 'message_start') tokens = [event.message.usage.input_tokens, 0, 0];
      if (event.type === 'message_delta') {
        tokens = [event.usage.input_tokens ?? tokens[0], event.usage.output_tokens, (event.usage.input_tokens ?? tokens[0]) + event.usage.output_tokens];
        reason = event.delta.stop_reason;
      }
    } else {
      for (const part of event.candidates?.[0]?.content?.parts ?? []) {
        if (part.text) text += part.text;
        if (part.functionCall) calls.set(calls.size, { id: part.functionCall.id, name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args) });
      }
      if (event.usageMetadata) tokens = [event.usageMetadata.promptTokenCount, event.usageMetadata.candidatesTokenCount, event.usageMetadata.totalTokenCount];
      if (event.candidates?.[0]?.finishReason) reason = event.candidates[0].finishReason;
    }
  }
  return { text, calls: [...calls.values()], tokens, reason };
}

afterEach(() => vi.useRealTimers());

describe('stream protocol conversion', () => {
  for (const from of protocols) for (const to of protocols) it(`${from} -> ${to} preserves split UTF-8 text, tools and usage`, async () => {
    const input = source(sourceFrames[from], 7);
    const converted = convertStream(input, from, to, 'client-model');
    if (from === to) expect(converted).toBe(input);
    const output = events(await collect(converted));
    expect(summary(output, to)).toEqual({ text: content, calls: [{ id: 'call_1', name: 'weather', arguments: argumentsText }], tokens: [25, 6, 31], reason: to === 'responses' ? 'completed' : to === 'anthropic' ? 'tool_use' : to === 'gemini' ? 'STOP' : 'tool_calls' });
    if (to === 'responses' && from !== to) {
      expect(output.map(event => event.sequence_number)).toEqual(output.map((_, sequence) => sequence));
      const added = output.filter(event => event.type === 'response.output_item.added');
      const done = output.filter(event => event.type === 'response.output_item.done');
      expect(done.map(event => [event.output_index, event.item.id])).toEqual(added.map(event => [event.output_index, event.item.id]));
      expect(output.at(-1).response.output.map((item: any) => item.id)).toEqual(added.map(event => event.item.id));
    }
  });

  it('emits text before the upstream terminal event arrives', async () => {
    let upstream!: ReadableStreamDefaultController<Uint8Array>;
    const input = new ReadableStream<Uint8Array>({ start(controller) { upstream = controller; } });
    const reader = convertStream(input, 'openai', 'anthropic', 'm').getReader();
    upstream.enqueue(encode.encode(chat({ content: 'first' })));
    const output: any[] = [];
    while (!output.some(event => event.delta?.text === 'first')) {
      const next = await reader.read();
      output.push(...events(new TextDecoder().decode(next.value)));
    }
    expect(output.some(event => event.type === 'message_stop')).toBe(false);
    await reader.cancel();
    reader.releaseLock();
    expect(input.locked).toBe(false);
  });

  for (const from of protocols) it(`rejects truncated ${from} streams without synthesizing success`, async () => {
    const truncated = sourceFrames[from].slice(0, -1);
    await expect(collect(convertStream(source(truncated), from, from === 'openai' ? 'responses' : 'openai', 'm'))).rejects.toThrow(/terminal event/);
  });

  it('rejects an OpenAI DONE marker without finish_reason', async () => {
    await expect(collect(convertStream(source([chat({ content: 'partial' }), 'data: [DONE]\n\n']), 'openai', 'responses', 'm'))).rejects.toThrow(/finish reason/);
  });

  for (const to of ['responses', 'anthropic', 'gemini'] as Protocol[]) it(`retains token exhaustion when streaming to ${to}`, async () => {
    const output = events(await collect(convertStream(source([chat({ content: 'partial' }), chat({}, 'length'), 'data: [DONE]\n\n']), 'openai', to, 'm')));
    if (to === 'responses') expect(output.at(-1)).toMatchObject({ type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } });
    if (to === 'anthropic') expect(output.find(event => event.type === 'message_delta').delta.stop_reason).toBe('max_tokens');
    if (to === 'gemini') expect(output.at(-1).candidates[0].finishReason).toBe('MAX_TOKENS');
  });

  it('keeps parallel call indices independent and permits tool-only responses', async () => {
    const input = [
      chat({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'one', arguments: '{"a":' } }] }),
      chat({ tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'two', arguments: '{"b":' } }] }),
      chat({ tool_calls: [{ index: 1, function: { arguments: '2}' } }, { index: 0, function: { arguments: '1}' } }] }),
      chat({}, 'tool_calls'), 'data: [DONE]\n\n',
    ];
    for (const to of ['responses', 'anthropic', 'gemini'] as Protocol[]) {
      const output = events(await collect(convertStream(source(input), 'openai', to, 'm')));
      expect(summary(output, to).calls).toEqual([{ id: 'call_a', name: 'one', arguments: '{"a":1}' }, { id: 'call_b', name: 'two', arguments: '{"b":2}' }]);
      if (to === 'responses') expect(output.at(-1).response.output.map((item: any) => item.type)).toEqual(['function_call', 'function_call']);
    }
  });

  it('does not duplicate completed Responses text or argument snapshots', async () => {
    const output = events(await collect(convertStream(source(sourceFrames.responses), 'responses', 'openai', 'm')));
    expect(summary(output, 'openai').text).toBe(content);
    expect(summary(output, 'openai').calls[0].arguments).toBe(argumentsText);
  });

  for (const to of ['openai', 'responses', 'anthropic'] as Protocol[]) it(`retains Gemini usage-only frames after finishReason when converting to ${to}`, async () => {
    const input = [
      frame({ responseId: 'late_usage', candidates: [{ index: 0, content: { parts: [{ text: 'answer' }] } }] }),
      frame({ candidates: [{ index: 0, finishReason: 'STOP' }] }),
      frame({ usageMetadata: { promptTokenCount: 13, candidatesTokenCount: 7, totalTokenCount: 20 } }),
    ];
    const output = events(await collect(convertStream(source(input, 13), 'gemini', to, 'm')));
    expect(summary(output, to)).toMatchObject({ text: 'answer', tokens: [13, 7, 20] });
  });

  it('does not report Gemini success if the transport fails after finishReason', async () => {
    let step = 0;
    const input = new ReadableStream<Uint8Array>({ pull(controller) {
      if (step++ === 0) controller.enqueue(encode.encode(frame({ candidates: [{ content: { parts: [{ text: 'answer' }] }, finishReason: 'STOP' }] })));
      else controller.error(new Error('connection reset before usage'));
    } }, { highWaterMark: 0 });
    await expect(collect(convertStream(input, 'gemini', 'responses', 'm'))).rejects.toThrow(/stream read/);
  });

  it('rejects inconsistent completed snapshots instead of overwriting earlier deltas', async () => {
    const input = [...sourceFrames.responses.slice(0, 5), named('response.output_text.done', { output_index: 0, content_index: 0, text: 'different' })];
    await expect(collect(convertStream(source(input), 'responses', 'openai', 'm'))).rejects.toThrow(/differs/);
  });

  it('preserves empty-object tool inputs without JSON fragments', async () => {
    const input = [sourceFrames.anthropic[0], named('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'empty', name: 'now', input: {} } }), named('content_block_stop', { index: 0 }), named('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } }), named('message_stop')];
    const output = events(await collect(convertStream(source(input), 'anthropic', 'openai', 'm')));
    expect(summary(output, 'openai').calls).toEqual([{ id: 'empty', name: 'now', arguments: '{}' }]);
  });

  const invalidStreams: [Protocol, string[], RegExp][] = [
    ['openai', ['data: {broken}\n\n'], /invalid JSON/],
    ['openai', [chat({ reasoning_content: 'private' })], /reasoning_content/],
    ['responses', [named('response.failed', { response: { error: { message: 'failure' } } })], /error event/],
    ['responses', [named('response.output_item.added', { output_index: 0, item: { type: 'web_search_call', status: 'in_progress' } })], /web_search_call/],
    ['anthropic', [named('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'orphan' } })], /out-of-order/],
    ['anthropic', [named('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } })], /thinking/],
    ['gemini', [frame({ candidates: [{ content: { parts: [{ executableCode: { language: 'PYTHON', code: 'x' } }] } }] })], /executableCode/],
    ['gemini', [frame({ candidates: [{ finishReason: 'MALFORMED_FUNCTION_CALL' }] })], /did not complete successfully/],
  ];
  for (const [from, frames, error] of invalidStreams) it(`rejects unsupported or invalid ${from} SSE: ${error.source}`, async () => {
    await expect(collect(convertStream(source(frames), from, from === 'openai' ? 'responses' : 'openai', 'm'))).rejects.toThrow(error);
  });

  it('releases and cancels the source on conversion failure', async () => {
    const cancelled = vi.fn();
    const input = source(['data: {broken}\n\n'], Infinity, cancelled);
    await expect(collect(convertStream(input, 'openai', 'responses', 'm'))).rejects.toThrow(ProtocolConversionError);
    await Promise.resolve();
    expect(cancelled).toHaveBeenCalledOnce();
    expect(input.locked).toBe(false);
  });
});

describe('stream monitoring', () => {
  function monitor(input: ReadableStream<Uint8Array>, protocol: Protocol, values: Partial<{ heartbeatMs: number; timeoutMs: number }> = {}) {
    const complete = vi.fn<(result: StreamResult) => void>();
    const abort = vi.fn();
    const output = monitorStream(input, protocol, { started: Date.now(), heartbeatMs: 1000, timeoutMs: 10000, ...values, abort, complete });
    return { output, complete, abort };
  }

  for (const protocol of protocols) it(`monitors a valid ${protocol} stream byte-for-byte`, async () => {
    const original = sourceFrames[protocol].join('');
    const { output, complete, abort } = monitor(source(sourceFrames[protocol], 17), protocol);
    expect(await collect(output)).toBe(original);
    expect(complete).toHaveBeenCalledOnce();
    expect(complete.mock.calls[0][0]).toMatchObject({ outcome: 'ok', firstByteMs: expect.any(Number) });
    expect(abort).not.toHaveBeenCalled();
  });

  it('preserves malformed payload bytes while recording an invalid-JSON failure', async () => {
    const input = ['data: not-json\n\n', chat({}, 'stop'), 'data: [DONE]\n\n'];
    const { output, complete } = monitor(source(input), 'openai');
    expect(await collect(output)).toBe(input.join(''));
    expect(complete.mock.calls[0][0]).toMatchObject({ outcome: 'error', error: 'upstream_invalid_json' });
  });

  it('never accepts another protocol terminal marker', async () => {
    const { output, complete } = monitor(source([named('message_stop')]), 'responses');
    expect(await collect(output)).toContain('上游流在结束事件前断开');
    expect(complete.mock.calls[0][0]).toMatchObject({ outcome: 'error', error: 'upstream_stream_truncated' });
  });

  it('does not cut off later Gemini candidates after an earlier candidate finishes', async () => {
    const input = [
      frame({ candidates: [{ index: 0, content: { parts: [{ text: 'first' }] }, finishReason: 'STOP' }] }),
      frame({ candidates: [{ index: 1, content: { parts: [{ text: 'second' }] } }] }),
      frame({ candidates: [{ index: 1, content: { parts: [{ text: ' answer' }] }, finishReason: 'STOP' }] }),
    ];
    const { output, complete } = monitor(source(input, 11), 'gemini');
    expect(await collect(output)).toBe(input.join(''));
    expect(complete.mock.calls[0][0].outcome).toBe('ok');
  });

  it('reports an unfinished Gemini candidate even when a different candidate completed', async () => {
    const input = [frame({ candidates: [{ index: 0, finishReason: 'STOP' }, { index: 1, content: { parts: [{ text: 'partial' }] } }] })];
    const { output, complete } = monitor(source(input), 'gemini');
    expect(await collect(output)).toContain('上游流在结束事件前断开');
    expect(complete.mock.calls[0][0]).toMatchObject({ outcome: 'error', error: 'upstream_stream_truncated' });
  });

  it('flags Responses token exhaustion as incomplete in request logs', async () => {
    const input = [named('response.incomplete', { response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } })];
    const { output, complete } = monitor(source(input), 'responses');
    expect(await collect(output)).toBe(input.join(''));
    expect(complete.mock.calls[0][0]).toMatchObject({ outcome: 'error', error: 'upstream_generation_incomplete' });
  });

  it('propagates a provider error without reporting success', async () => {
    const input = [named('error', { error: { type: 'overloaded_error', message: 'try later' } })];
    const { output, complete } = monitor(source(input), 'anthropic');
    const text = await collect(output);
    expect(text).toContain('try later');
    expect(text).not.toContain('overloaded_error');
    expect(complete.mock.calls[0][0]).toMatchObject({ outcome: 'error', error: 'upstream_stream_error', errorMessage: 'try later' });
  });

  it('keeps the upstream message of a failed Responses stream for the request log', async () => {
    const input = [named('response.failed', { response: { status: 'failed', error: { code: 'server_error', message: 'Upstream rejected the request as invalid [trace_id=038efdd6c1a97b23714488cea56c3070]' } } })];
    const { output, complete } = monitor(source(input), 'responses');
    await collect(output);
    expect(complete.mock.calls[0][0]).toMatchObject({ outcome: 'error', error: 'upstream_stream_error', errorMessage: 'Upstream rejected the request as invalid [trace_id=038efdd6c1a97b23714488cea56c3070]' });
  });

  it('keeps the upstream reason when a cross-protocol conversion rejects the error event', async () => {
    const upstream = 'Upstream rejected the request as invalid [trace_id=038efdd6c1a97b23714488cea56c3070]';
    const input = [named('response.failed', { response: { status: 'failed', error: { code: 'server_error', message: upstream } } })];
    const { output, complete } = monitor(convertStream(source(input), 'responses', 'openai', 'm'), 'openai');
    await collect(output);
    expect(complete.mock.calls[0][0]).toMatchObject({ outcome: 'error', errorMessage: expect.stringContaining(upstream) });
  });

  it('omits errorMessage when a provider error carries no readable message', async () => {
    const input = [frame({ error: { code: 'overloaded' } })];
    const { output, complete } = monitor(source(input), 'openai');
    await collect(output);
    expect(complete.mock.calls[0][0]).toMatchObject({ outcome: 'error', error: 'upstream_stream_error', errorMessage: 'overloaded' });
  });

  it('adds an explicit SSE error for abrupt EOF', async () => {
    const { output, complete } = monitor(source([chat({ content: 'partial' })]), 'openai');
    const data = events(await collect(output));
    expect(data.at(-1).error.code).toBe('upstream_stream_error');
    expect(data).not.toContain('[DONE]');
    expect(complete.mock.calls[0][0]).toMatchObject({ outcome: 'error', error: 'upstream_stream_truncated' });
  });

  it('assigns injected Responses errors the next sequence number', async () => {
    const input = [named('response.created', { sequence_number: 4, response: { id: 'partial', status: 'in_progress', output: [] } })];
    const { output } = monitor(source(input), 'responses');
    expect(events(await collect(output)).at(-1)).toMatchObject({ type: 'error', sequence_number: 5 });
  });

  it('stops on terminal events even if the upstream socket stays open', async () => {
    const cancelled = vi.fn();
    const input = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encode.encode(chat({}, 'stop') + 'data: [DONE]\n\n')); }, cancel: cancelled });
    const { output, complete } = monitor(input, 'openai');
    await collect(output);
    await Promise.resolve();
    expect(complete.mock.calls[0][0].outcome).toBe('ok');
    expect(cancelled).toHaveBeenCalledOnce();
    expect(input.locked).toBe(false);
  });

  it('has only one outstanding read while sending heartbeats and enforcing idle timeout', async () => {
    vi.useFakeTimers();
    const pulls = vi.fn();
    const cancelled = vi.fn();
    const input = new ReadableStream<Uint8Array>({ pull: pulls, cancel: cancelled }, { highWaterMark: 0 });
    const { output, complete, abort } = monitor(input, 'openai', { heartbeatMs: 10, timeoutMs: 35 });
    const reader = output.getReader();
    for (let heartbeat = 0; heartbeat < 3; heartbeat++) {
      const next = reader.read();
      await vi.advanceTimersByTimeAsync(10);
      expect(new TextDecoder().decode((await next).value)).toContain(': ap-heartbeat');
    }
    const timedOut = reader.read();
    await vi.advanceTimersByTimeAsync(5);
    expect(new TextDecoder().decode((await timedOut).value)).toContain('超时');
    expect(pulls).toHaveBeenCalledOnce();
    expect(abort).toHaveBeenCalledOnce();
    expect(cancelled).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledOnce();
    expect(complete.mock.calls[0][0]).toMatchObject({ outcome: 'error', firstByteMs: null });
    expect((await reader.read()).done).toBe(true);
    reader.releaseLock();
    expect(input.locked).toBe(false);
  });

  it('cancels a pending read once and releases both stream layers', async () => {
    const cancelled = vi.fn();
    const input = new ReadableStream<Uint8Array>({ cancel: cancelled }, { highWaterMark: 0 });
    const converted = convertStream(input, 'openai', 'responses', 'm');
    const { output, complete, abort } = monitor(converted, 'responses');
    const reader = output.getReader();
    const pending = reader.read();
    await Promise.resolve();
    await reader.cancel('stop button');
    expect((await pending).done).toBe(true);
    reader.releaseLock();
    expect(abort).toHaveBeenCalledOnce();
    expect(cancelled).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledOnce();
    expect(complete.mock.calls[0][0]).toMatchObject({ outcome: 'cancelled', error: 'client_cancelled' });
    expect(input.locked).toBe(false);
    expect(converted.locked).toBe(false);
  });
});
