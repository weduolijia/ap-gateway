import { describe, expect, it } from 'vitest';
import { convertRequest, convertResponse, ProtocolConversionError } from '../src/protocols';
import type { Protocol } from '../src/types';

const protocols: Protocol[] = ['openai', 'responses', 'anthropic', 'gemini'];
const schema = { type: 'object', properties: { location: { type: 'string' } }, required: ['location'] };
const call = { id: 'call_weather', name: 'weather', arguments: '{"location":"Paris"}' };
const image = 'data:image/png;base64,aGVsbG8=';
const requests: Record<Protocol, any> = {
  openai: {
    model: 'client-model', messages: [
      { role: 'system', content: 'Be concise' }, { role: 'user', content: 'Weather?' },
      { role: 'assistant', content: 'Checking', tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }] },
      { role: 'tool', tool_call_id: call.id, content: '{"temperature":22}' },
      { role: 'user', content: [{ type: 'text', text: 'And this image?' }, { type: 'image_url', image_url: { url: image } }] },
    ], tools: [{ type: 'function', function: { name: 'weather', description: 'Get weather', parameters: schema } }], tool_choice: 'auto', max_tokens: 120, temperature: 0.2, top_p: 0.9,
  },
  responses: {
    model: 'client-model', instructions: 'Be concise', input: [
      { role: 'user', content: 'Weather?' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Checking', annotations: [] }] },
      { type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments },
      { type: 'function_call_output', call_id: call.id, output: '{"temperature":22}' },
      { role: 'user', content: [{ type: 'input_text', text: 'And this image?' }, { type: 'input_image', image_url: image }] },
    ], tools: [{ type: 'function', name: 'weather', description: 'Get weather', parameters: schema }], tool_choice: 'auto', max_output_tokens: 120, temperature: 0.2, top_p: 0.9,
  },
  anthropic: {
    model: 'client-model', system: 'Be concise', messages: [
      { role: 'user', content: 'Weather?' },
      { role: 'assistant', content: [{ type: 'text', text: 'Checking' }, { type: 'tool_use', id: call.id, name: call.name, input: JSON.parse(call.arguments) }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: '{"temperature":22}' }, { type: 'text', text: 'And this image?' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } }] },
    ], tools: [{ name: 'weather', description: 'Get weather', input_schema: schema }], tool_choice: { type: 'auto' }, max_tokens: 120, temperature: 0.2, top_p: 0.9,
  },
  gemini: {
    systemInstruction: { parts: [{ text: 'Be concise' }] }, contents: [
      { role: 'user', parts: [{ text: 'Weather?' }] },
      { role: 'model', parts: [{ text: 'Checking' }, { functionCall: { id: call.id, name: call.name, args: JSON.parse(call.arguments) } }] },
      { role: 'user', parts: [{ functionResponse: { id: call.id, name: call.name, response: { temperature: 22 } } }, { text: 'And this image?' }, { inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' } }] },
    ], tools: [{ functionDeclarations: [{ name: 'weather', description: 'Get weather', parameters: schema }] }], toolConfig: { functionCallingConfig: { mode: 'AUTO' } }, generationConfig: { maxOutputTokens: 120, temperature: 0.2, topP: 0.9 },
  },
};
const responses: Record<Protocol, any> = {
  openai: { id: 'result_1', choices: [{ index: 0, message: { role: 'assistant', content: 'Checking', tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 25, completion_tokens: 6, total_tokens: 31 } },
  responses: { id: 'result_1', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Checking', annotations: [] }] }, { type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments }], usage: { input_tokens: 25, output_tokens: 6, total_tokens: 31 } },
  anthropic: { id: 'result_1', content: [{ type: 'text', text: 'Checking' }, { type: 'tool_use', id: call.id, name: call.name, input: JSON.parse(call.arguments) }], stop_reason: 'tool_use', usage: { input_tokens: 25, output_tokens: 6 } },
  gemini: { responseId: 'result_1', candidates: [{ content: { role: 'model', parts: [{ text: 'Checking' }, { functionCall: { id: call.id, name: call.name, args: JSON.parse(call.arguments) } }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 25, candidatesTokenCount: 6, totalTokenCount: 31 } },
};

describe('request conversions', () => {
  for (const from of protocols) for (const to of protocols) {
    it(`${from} -> ${to} preserves text/image/function round trip`, () => {
      const input = structuredClone(requests[from]);
      const converted = convertRequest(input, from, to, 'upstream-model', true);
      if (from === to) { expect(converted).toBe(input); return; }
      expect(input).toEqual(requests[from]);
      const chat = to === 'openai' ? converted : convertRequest(converted, to, 'openai', 'upstream-model', true);
      expect(chat.model).toBe('upstream-model');
      expect(chat.stream).toBe(true);
      expect(chat.stream_options).toEqual({ include_usage: true });
      expect(chat.messages.find((m: any) => m.role === 'system').content).toBe('Be concise');
      const assistant = chat.messages.find((m: any) => m.role === 'assistant');
      expect(assistant.content).toBe('Checking');
      expect(assistant.tool_calls).toEqual([{ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }]);
      expect(chat.messages.find((m: any) => m.role === 'tool')).toMatchObject({ tool_call_id: call.id, content: '{"temperature":22}' });
      expect(chat.messages.at(-1).content).toEqual([{ type: 'text', text: 'And this image?' }, { type: 'image_url', image_url: { url: image, ...(to === 'responses' ? { detail: 'auto' } : {}) } }]);
      expect(chat.tools[0].function).toMatchObject({ name: 'weather', parameters: schema });
      expect(chat.max_completion_tokens).toBe(120);
    });
  }

  it('correlates multiple Gemini tool outputs by name rather than global FIFO', () => {
    const body = { contents: [
      { role: 'model', parts: [{ functionCall: { name: 'one', args: {} } }, { functionCall: { name: 'two', args: {} } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'two', response: { ok: 2 } } }, { functionResponse: { name: 'one', response: { ok: 1 } } }] },
    ] };
    const c = convertRequest(body, 'gemini', 'openai', 'm', false);
    expect(c.messages[1].tool_call_id).toBe(c.messages[0].tool_calls[1].id);
    expect(c.messages[2].tool_call_id).toBe(c.messages[0].tool_calls[0].id);
  });
  it('preserves Anthropic tool failure information', () => {
    const body = { model: 'm', max_tokens: 100, messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'lookup', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'offline', is_error: true }] },
    ] };
    const c = convertRequest(body, 'anthropic', 'gemini', 'm', false);
    expect(c.contents[1].parts[0].functionResponse.response).toEqual({ error: 'offline' });
  });
  it('maps forced tool choice and parallel disabling', () => {
    const body = { ...requests.openai, tool_choice: { type: 'function', function: { name: 'weather' } }, parallel_tool_calls: false };
    const c = convertRequest(body, 'openai', 'anthropic', 'm', false);
    expect(c.tool_choice).toEqual({ type: 'tool', name: 'weather', disable_parallel_tool_use: true });
  });
  it('maps structured JSON schema between Responses and Chat', () => {
    const body = { model: 'm', input: 'hello', text: { format: { type: 'json_schema', name: 'answer', schema, strict: true } }, reasoning: { effort: 'low' } };
    const c = convertRequest(body, 'responses', 'openai', 'm', false);
    expect(c.response_format).toMatchObject({ type: 'json_schema', json_schema: { name: 'answer', schema, strict: true } });
    expect(c.reasoning_effort).toBe('low');
  });
  it('converts public image URL to Anthropic source URL', () => {
    const c = convertRequest({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/image.png' } }] }] }, 'openai', 'anthropic', 'm', false);
    expect(c.messages[0].content[0]).toEqual({ type: 'image', source: { type: 'url', url: 'https://example.com/image.png' } });
  });
});

describe('unsupported semantics fail explicitly', () => {
  const cases: [Protocol, any][] = [
    ['responses', { input: 'hello', previous_response_id: 'resp_old' }],
    ['responses', { input: 'hello', tools: [{ type: 'web_search' }] }],
    ['responses', { input: [{ type: 'item_reference', id: 'old' }] }],
    ['responses', { input: [{ role: 'user', content: [{ type: 'input_file', file_id: 'f1' }] }] }],
    ['responses', { input: 'hi', reasoning: { summary: 'auto' } }],
    ['openai', { messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'AAAA', format: 'wav' } }] }] }],
    ['openai', { messages: [], n: 2 }],
    ['openai', { messages: [], frequency_penalty: 1 }],
    ['anthropic', { messages: [], thinking: { type: 'enabled', budget_tokens: 1024 } }],
    ['anthropic', { messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'base64', data: 'x' } }] }] }],
    ['anthropic', { system: [{ type: 'text', text: 'cached', cache_control: { type: 'ephemeral' } }], messages: [] }],
    ['gemini', { contents: [], tools: [{ googleSearch: {} }] }],
    ['gemini', { contents: [{ role: 'model', parts: [{ text: 'thinking', thought: true }] }] }],
    ['gemini', { contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'audio/wav', data: 'AAAA' } }] }] }],
    ['gemini', { contents: [{ role: 'user', parts: [{ functionResponse: { name: 'missing', response: {} } }] }] }],
  ];
  for (const [from, body] of cases) it(`rejects unsupported ${from}: ${JSON.stringify(body).slice(0, 100)}`, () => {
    expect(() => convertRequest(body, from, from === 'openai' ? 'responses' : 'openai', 'm', false)).toThrow(ProtocolConversionError);
    try { convertRequest(body, from, from === 'openai' ? 'responses' : 'openai', 'm', false); } catch (e) { expect((e as ProtocolConversionError).status).toBe(400); }
  });
  it('does not validate or alter provider extensions in same-protocol routing', () => {
    const body = { previous_response_id: 'state', input: [{ type: 'custom' }], provider_specific: true };
    expect(convertRequest(body, 'responses', 'responses', 'ignored', false)).toBe(body);
    expect(convertResponse(body, 'responses', 'responses', 'ignored')).toBe(body);
  });
  it('rejects malformed tool JSON instead of silently replacing it with {}', () => {
    const body = structuredClone(responses.openai); body.choices[0].message.tool_calls[0].function.arguments = '{bad';
    expect(() => convertResponse(body, 'openai', 'anthropic', 'm')).toThrow(/invalid JSON/);
  });
});

describe('response conversions', () => {
  it('accepts empty optional provider metadata without losing actual annotations', () => {
    const chat = { choices: [{ message: { role: 'assistant', content: 'Hi', annotations: [] }, logprobs: null, finish_reason: 'stop' }] };
    expect(convertResponse(chat, 'openai', 'anthropic', 'm').content).toEqual([{ type: 'text', text: 'Hi' }]);
    const anthropic = { content: [{ type: 'text', text: 'Hi', citations: [] }], stop_reason: 'end_turn' };
    expect(convertResponse(anthropic, 'anthropic', 'openai', 'm').choices[0].message.content).toBe('Hi');
    const response = { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hi', annotations: [], logprobs: [] }] }] };
    expect(convertResponse(response, 'responses', 'openai', 'm').choices[0].message.content).toBe('Hi');
    expect(() => convertResponse({ ...anthropic, content: [{ type: 'text', text: 'Hi', citations: [{ type: 'char_location', cited_text: 'Hi' }] }] }, 'anthropic', 'openai', 'm')).toThrow(/cited text/);
  });
  it('reports malformed upstream data as HTTP 502 rather than blaming client input', () => {
    try {
      convertResponse({ choices: [{ message: { role: 'user', content: 'Hi' }, finish_reason: 'stop' }] }, 'openai', 'responses', 'm');
      expect.fail('Expected malformed upstream response to fail');
    } catch (error) { expect(error).toMatchObject({ status: 502 }); }
    try {
      convertResponse({ choices: 'invalid' }, 'openai', 'anthropic', 'm');
      expect.fail('Expected malformed upstream choices to fail');
    } catch (error) { expect(error).toMatchObject({ status: 502 }); }
  });
  for (const from of protocols) for (const to of protocols) it(`${from} -> ${to} preserves response tool arguments and usage`, () => {
    const input = structuredClone(responses[from]);
    const converted = convertResponse(input, from, to, 'client-model');
    if (from === to) { expect(converted).toBe(input); return; }
    const chat = to === 'openai' ? converted : convertResponse(converted, to, 'openai', 'client-model');
    expect(chat.model).toBe('client-model');
    expect(chat.choices[0].message.content).toBe('Checking');
    expect(chat.choices[0].message.tool_calls[0]).toEqual({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } });
    expect(chat.choices[0].finish_reason).toBe('tool_calls');
    expect(chat.usage).toMatchObject({ prompt_tokens: 25, completion_tokens: 6, total_tokens: 31 });
    expect(input).toEqual(responses[from]);
  });
  it('does not turn token truncation into Responses completed', () => {
    const body = { choices: [{ message: { content: 'Partial' }, finish_reason: 'length' }] };
    expect(convertResponse(body, 'openai', 'responses', 'm')).toMatchObject({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } });
  });
  it('counts Anthropic cache read/write in Chat prompt total', () => {
    const body = { content: [{ type: 'text', text: 'Hi' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 20, cache_creation_input_tokens: 8 } };
    expect(convertResponse(body, 'anthropic', 'openai', 'm').usage).toMatchObject({ prompt_tokens: 33, completion_tokens: 3, total_tokens: 36, prompt_tokens_details: { cached_tokens: 20 } });
  });
  it('counts Gemini thoughts as output usage without exposing reasoning content', () => {
    const body = { candidates: [{ content: { parts: [{ text: 'answer' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, thoughtsTokenCount: 7, totalTokenCount: 20 } };
    expect(convertResponse(body, 'gemini', 'openai', 'm').usage).toMatchObject({ prompt_tokens: 10, completion_tokens: 10, total_tokens: 20, completion_tokens_details: { reasoning_tokens: 7 } });
  });
  it('preserves refusal as refusal and blocked finish status', () => {
    const body = { choices: [{ message: { content: null, refusal: 'Cannot comply' }, finish_reason: 'content_filter' }] };
    expect(convertResponse(body, 'openai', 'responses', 'm')).toMatchObject({ status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output: [{ content: [{ type: 'refusal', refusal: 'Cannot comply' }] }] });
  });
  it('rejects upstream failed response instead of returning a successful completion', () => {
    expect(() => convertResponse({ status: 'failed', error: { message: 'provider error' } }, 'responses', 'openai', 'm')).toThrow(/provider error/);
    expect(() => convertResponse({ candidates: [{ finishReason: 'MALFORMED_FUNCTION_CALL' }] }, 'gemini', 'openai', 'm')).toThrow(/did not complete successfully/);
    expect(() => convertResponse({ choices: [{ message: { content: 'unfinished' }, finish_reason: null }] }, 'openai', 'responses', 'm')).toThrow(/finish_reason/);
  });
});
