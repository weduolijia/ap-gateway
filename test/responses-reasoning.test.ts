import { describe, expect, it } from 'vitest';
import { createParser } from 'eventsource-parser';
import { convertResponse, convertStream } from '../src/protocols';
import type { Protocol } from '../src/types';

const destinations = ['openai', 'anthropic', 'gemini'] as const;
const answer = 'Hello 世界';
const summaryText = 'Summary fixture: checking the answer.';
const reasoningText = 'Raw reasoning fixture: internal calculation.';
const encryptedContent = 'fake_encrypted_data_for_test_only';
const tokens = { input_tokens: 29, output_tokens: 12, total_tokens: 41, output_tokens_details: { reasoning_tokens: 7 } };
const message = { id: 'msg_answer', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: answer, annotations: [] }] };
const tool = { id: 'fc_weather', type: 'function_call', call_id: 'call_weather', name: 'weather', arguments: '{"city":"Paris"}', status: 'completed' };
const encoder = new TextEncoder();
const event = (type: string, body: any = {}) => ({ type, ...body });

function reasoning(details: boolean) {
  return {
    id: 'rs_fixture', type: 'reasoning', status: 'completed',
    summary: details ? [{ type: 'summary_text', text: summaryText }] : [],
    ...(details ? { content: [{ type: 'reasoning_text', text: reasoningText }], encrypted_content: encryptedContent } : {}),
  };
}

function completed(output: any[] = [reasoning(true), message]) {
  return { id: 'resp_reasoning', object: 'response', created_at: 12345, model: 'upstream-model', status: 'completed', error: null, incomplete_details: null, output, usage: tokens };
}

function reasoningFrames(details = true) {
  const item = reasoning(details);
  const location = { item_id: item.id, output_index: 0 };
  return [
    event('response.created', { response: { ...completed([]), status: 'in_progress', usage: null } }),
    event('response.output_item.added', { output_index: 0, item: { id: item.id, type: item.type, status: 'in_progress', summary: [] } }),
    ...(details ? [
      event('response.reasoning_summary_part.added', { ...location, summary_index: 0, part: { type: 'summary_text', text: '' } }),
      event('response.reasoning_summary_text.delta', { ...location, summary_index: 0, delta: 'Summary fixture: ' }),
      event('response.reasoning_summary_text.delta', { ...location, summary_index: 0, delta: 'checking the answer.' }),
      event('response.reasoning_summary_text.done', { ...location, summary_index: 0, text: summaryText }),
      event('response.reasoning_summary_part.done', { ...location, summary_index: 0, part: { type: 'summary_text', text: summaryText } }),
      event('response.reasoning_text.delta', { ...location, content_index: 0, delta: reasoningText }),
      event('response.reasoning_text.done', { ...location, content_index: 0, text: reasoningText }),
    ] : []),
    event('response.output_item.done', { output_index: 0, item }),
  ];
}

function answerFrames(details = true) {
  const location = { item_id: message.id, output_index: 1, content_index: 0 };
  return [
    ...reasoningFrames(details),
    event('response.output_item.added', { output_index: 1, item: { ...message, status: 'in_progress', content: [] } }),
    event('response.content_part.added', { ...location, part: { type: 'output_text', text: '', annotations: [] } }),
    event('response.output_text.delta', { ...location, delta: 'Hello ' }),
    event('response.output_text.delta', { ...location, delta: '世界' }),
    event('response.output_text.done', { ...location, text: answer }),
    event('response.content_part.done', { ...location, part: message.content[0] }),
    event('response.output_item.done', { output_index: 1, item: message }),
    event('response.completed', { response: completed([reasoning(details), message]) }),
  ];
}

function serialize(frames: any[]) {
  return frames.map((body, sequence_number) => `event: ${body.type}\r\ndata: ${JSON.stringify({ ...body, sequence_number })}\r\n\r\n`).join('');
}

function source(wire: string) {
  const bytes = encoder.encode(wire);
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.slice(offset, offset + 11));
      offset += 11;
    },
  }, { highWaterMark: 0 });
}

function events(wire: string): any[] {
  const result: any[] = [];
  const parser = createParser({ onEvent(frame) { result.push(frame.data === '[DONE]' ? '[DONE]' : JSON.parse(frame.data)); } });
  parser.feed(wire);
  return result;
}

async function converted(frames: any[], destination: Protocol) {
  return new Response(convertStream(source(serialize(frames)), 'responses', destination, 'client-model')).text();
}

async function captureFailure(frames: any[]) {
  const reader = convertStream(source(serialize(frames)), 'responses', 'openai', 'client-model').getReader();
  const decoder = new TextDecoder();
  let wire = '';
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return { wire, error: undefined };
      wire += decoder.decode(next.value, { stream: true });
    }
  } catch (error) { return { wire, error }; }
  finally { reader.releaseLock(); }
}

function expectNoReasoning(wire: string) {
  expect(wire).not.toContain(summaryText);
  expect(wire).not.toContain(reasoningText);
  expect(wire).not.toContain(encryptedContent);
}

describe('Responses reasoning output conversion', () => {
  for (const details of [false, true]) it.each(destinations)(`streams only the final answer to %s with reasoning details=${details}`, async destination => {
    const wire = await converted(answerFrames(details), destination);
    const output = events(wire);
    expectNoReasoning(wire);
    if (destination === 'openai') {
      expect(output.map(frame => frame.choices?.[0]?.delta?.content ?? '').join('')).toBe(answer);
      expect(output.find(frame => frame.usage)?.usage).toMatchObject({ prompt_tokens: 29, completion_tokens: 12, total_tokens: 41, completion_tokens_details: { reasoning_tokens: 7 } });
      expect(output.find(frame => frame.choices?.[0]?.finish_reason)?.choices[0].finish_reason).toBe('stop');
      expect(output.at(-1)).toBe('[DONE]');
    } else if (destination === 'anthropic') {
      expect(output.filter(frame => frame.delta?.type === 'text_delta').map(frame => frame.delta.text).join('')).toBe(answer);
      expect(output.find(frame => frame.type === 'message_delta')).toMatchObject({ delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 29, output_tokens: 12 } });
      expect(output.at(-1).type).toBe('message_stop');
    } else {
      expect(output.flatMap(frame => frame.candidates?.[0]?.content?.parts ?? []).map(part => part.text ?? '').join('')).toBe(answer);
      expect(output.at(-1)).toMatchObject({ candidates: [{ finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 29, candidatesTokenCount: 5, thoughtsTokenCount: 7, totalTokenCount: 41 } });
    }
  });

  it.each(destinations)('converts a nonstream response to %s without including reasoning in assistant content', destination => {
    const body = completed();
    const original = structuredClone(body);
    const output = convertResponse(body, 'responses', destination, 'client-model');
    expectNoReasoning(JSON.stringify(output));
    expect(body).toEqual(original);
    if (destination === 'openai') {
      expect(output.choices).toEqual([{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }]);
      expect(output.usage).toMatchObject({ prompt_tokens: 29, completion_tokens: 12, total_tokens: 41, completion_tokens_details: { reasoning_tokens: 7 } });
    } else if (destination === 'anthropic') {
      expect(output.content).toEqual([{ type: 'text', text: answer }]);
      expect(output.stop_reason).toBe('end_turn');
      expect(output.usage).toMatchObject({ input_tokens: 29, output_tokens: 12 });
    } else {
      expect(output.candidates).toEqual([{ index: 0, content: { role: 'model', parts: [{ text: answer }] }, finishReason: 'STOP' }]);
      expect(output.usageMetadata).toMatchObject({ promptTokenCount: 29, candidatesTokenCount: 5, thoughtsTokenCount: 7, totalTokenCount: 41 });
    }
  });

  it('preserves every original Responses byte and nonstream reasoning field during same-protocol routing', async () => {
    const wire = ': upstream keepalive\r\n\r\n' + serialize(answerFrames());
    const input = source(wire);
    const output = convertStream(input, 'responses', 'responses', 'client-model');
    expect(output).toBe(input);
    expect(new Uint8Array(await new Response(output).arrayBuffer())).toEqual(encoder.encode(wire));
    const body = completed();
    expect(convertResponse(body, 'responses', 'responses', 'client-model')).toBe(body);
  });

  it('yields reasoning activity before more upstream data arrives and releases the source on cancellation', async () => {
    let upstream!: ReadableStreamDefaultController<Uint8Array>;
    let unexpectedPull = () => {};
    let cancellation: unknown;
    const input = new ReadableStream<Uint8Array>({
      start(controller) { upstream = controller; },
      pull() { unexpectedPull(); },
      cancel(reason) { cancellation = reason; },
    }, { highWaterMark: 0 });
    const reader = convertStream(input, 'responses', 'openai', 'client-model').getReader();
    const frames = reasoningFrames();
    try {
      upstream.enqueue(encoder.encode(serialize([frames[0]])));
      expect(events(new TextDecoder().decode((await reader.read()).value))[0].choices[0].delta.role).toBe('assistant');
      for (const frame of frames.slice(1)) {
        const overread = new Promise<{ kind: 'overread' }>(resolve => { unexpectedPull = () => resolve({ kind: 'overread' }); });
        upstream.enqueue(encoder.encode(serialize([frame])));
        const next = reader.read().then(chunk => ({ kind: 'chunk' as const, chunk }));
        const result = await Promise.race([next, overread]);
        expect(result.kind, `${frame.type} must yield activity before requesting another source frame`).toBe('chunk');
        if (result.kind === 'chunk') {
          expect(result.chunk.done).toBe(false);
          const wire = new TextDecoder().decode(result.chunk.value);
          expect(wire).toMatch(/^: [^\r\n]+\n\n$/);
          expect(events(wire)).toEqual([]);
          expectNoReasoning(wire);
        }
      }
    } finally {
      await reader.cancel('reasoning consumer cancelled');
      reader.releaseLock();
    }
    expect(cancellation).toBe('reasoning consumer cancelled');
    expect(input.locked).toBe(false);
  });

  it.each([
    ['summary collection', { summary: { text: summaryText } }],
    ['summary part', { summary: [{ type: 'refusal', text: summaryText }] }],
    ['summary text', { summary: [{ type: 'summary_text', text: 42 }] }],
    ['reasoning content', { content: [{ type: 'output_text', text: reasoningText }] }],
    ['reasoning text', { content: [{ type: 'reasoning_text', text: false }] }],
    ['encrypted content', { encrypted_content: 42 }],
    ['item identity', { id: '' }],
  ])('rejects malformed %s with upstream error status 502', async (_label, invalidFields) => {
    const item = { ...reasoning(true), ...invalidFields };
    const body = completed([item, message]);
    let nonstreamError: unknown;
    try { convertResponse(body, 'responses', 'openai', 'client-model'); }
    catch (error) { nonstreamError = error; }
    expect(nonstreamError).toMatchObject({ status: 502, code: 'unsupported_protocol_conversion' });
    for (const type of ['response.output_item.added', 'response.output_item.done', 'response.completed']) {
      const payload = type === 'response.completed' ? { response: body } : { output_index: 0, item };
      await expect(converted([reasoningFrames()[0], event(type, payload)], 'openai')).rejects.toMatchObject({ status: 502, code: 'unsupported_protocol_conversion' });
    }
  });

  it.each(destinations)('preserves a tool call at output index 1 after reasoning when streaming to %s', async destination => {
    const location = { item_id: tool.id, output_index: 1 };
    const frames = [
      ...reasoningFrames(),
      event('response.output_item.added', { output_index: 1, item: { ...tool, status: 'in_progress', arguments: '' } }),
      event('response.function_call_arguments.delta', { ...location, delta: '{"city":' }),
      event('response.function_call_arguments.delta', { ...location, delta: '"Paris"}' }),
      event('response.function_call_arguments.done', { ...location, arguments: tool.arguments }),
      event('response.output_item.done', { output_index: 1, item: tool }),
      event('response.completed', { response: completed([reasoning(true), tool]) }),
    ];
    const wire = await converted(frames, destination);
    const output = events(wire);
    expectNoReasoning(wire);
    if (destination === 'openai') {
      const calls = output.flatMap(frame => frame.choices?.[0]?.delta?.tool_calls ?? []);
      expect(calls[0]).toMatchObject({ index: 0, id: tool.call_id, type: 'function', function: { name: tool.name } });
      expect(new Set(calls.map(call => call.index))).toEqual(new Set([0]));
      expect(calls.map(call => call.function?.arguments ?? '').join('')).toBe(tool.arguments);
      expect(output.find(frame => frame.choices?.[0]?.finish_reason)?.choices[0].finish_reason).toBe('tool_calls');
    } else if (destination === 'anthropic') {
      const start = output.find(frame => frame.content_block?.type === 'tool_use');
      expect(start.content_block).toMatchObject({ id: tool.call_id, name: tool.name });
      const deltas = output.filter(frame => frame.delta?.type === 'input_json_delta');
      expect(deltas.every(frame => frame.index === start.index)).toBe(true);
      expect(deltas.map(frame => frame.delta.partial_json).join('')).toBe(tool.arguments);
      expect(output.find(frame => frame.type === 'message_delta').delta.stop_reason).toBe('tool_use');
    } else {
      const calls = output.flatMap(frame => frame.candidates?.[0]?.content?.parts ?? []).filter(part => part.functionCall);
      expect(calls).toEqual([{ functionCall: { id: tool.call_id, name: tool.name, args: { city: 'Paris' } } }]);
      expect(output.at(-1).candidates[0].finishReason).toBe('STOP');
    }
    const nonstream = convertResponse(completed([reasoning(true), tool]), 'responses', 'openai', 'client-model');
    expect(nonstream.choices[0].message.tool_calls).toEqual([{ id: tool.call_id, type: 'function', function: { name: tool.name, arguments: tool.arguments } }]);
  });

  it('retains token exhaustion after reasoning instead of claiming a successful stop', async () => {
    const body = { ...completed(), status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } };
    const frames = [...answerFrames().slice(0, -1), event('response.incomplete', { response: body })];
    const output = events(await converted(frames, 'openai'));
    expect(output.find(frame => frame.choices?.[0]?.finish_reason)?.choices[0].finish_reason).toBe('length');
    expect(convertResponse(body, 'responses', 'openai', 'client-model').choices[0].finish_reason).toBe('length');
  });

  it.each([
    ['truncated', undefined, /terminal event/],
    ['failed', event('response.failed', { response: { ...completed(), status: 'failed', error: { message: 'provider failure fixture' } } }), /error event/],
    ['unknown incomplete', event('response.incomplete', { response: { ...completed(), status: 'incomplete', incomplete_details: { reason: 'provider_interrupted' } } }), /incomplete response/],
  ] as const)('does not synthesize completion after a %s reasoning stream', async (_label, terminal, expected) => {
    const frames = answerFrames().slice(0, -1);
    if (terminal) frames.push(terminal);
    const result = await captureFailure(frames);
    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toMatch(expected);
    expect(events(result.wire).some(frame => frame === '[DONE]' || frame.choices?.[0]?.finish_reason)).toBe(false);
  });

  it.each(['response.output_item.added', 'response.output_item.done', 'response.completed'])('still rejects an unknown non-reasoning item in %s', async type => {
    const item = { id: 'future_fixture', type: 'future_output', content: [] };
    const body = type === 'response.completed' ? { response: completed([reasoning(true), item]) } : { output_index: 1, item };
    await expect(converted([...reasoningFrames(), event(type, body)], 'openai')).rejects.toThrow(/Unsupported Responses .*future_output/);
    expect(() => convertResponse(completed([reasoning(true), item]), 'responses', 'openai', 'client-model')).toThrow(/Unsupported Responses output item future_output/);
  });
});
