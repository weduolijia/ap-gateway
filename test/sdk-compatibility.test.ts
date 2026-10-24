import { describe, expect, it } from 'vitest';
import { convertRequest, ProtocolConversionError } from '../src/protocols';
import type { Protocol } from '../src/types';

const schema = {
  type: 'object', properties: { city: { type: 'string' }, units: { type: ['string', 'null'], enum: ['celsius', null] } },
  required: ['city', 'units'], additionalProperties: false,
};
const shared = {
  metadata: { request: 'sdk-fixture', purpose: 'compatibility' }, user: 'test-user', safety_identifier: 'test-safety',
  prompt_cache_key: 'test-cache', prompt_cache_retention: 'in_memory', service_tier: 'priority', store: false,
};
const chat = {
  model: 'client-model', stream: true, stream_options: { include_usage: true }, ...shared,
  messages: [
    { role: 'developer', content: [{ type: 'text', text: 'Return JSON.' }] },
    { role: 'user', content: 'Weather in Paris?', tool_calls: null },
    {
      role: 'assistant', content: null, reasoning_content: null, reasoning: null, annotations: [], refusal: null,
      tool_calls: [{ id: 'call_weather_1', type: 'function', function: { name: 'weather', arguments: '{ "city": "Paris", "units": null }' } }],
    },
    { role: 'tool', tool_call_id: 'call_weather_1', content: '{"temperature":22}' },
    { role: 'user', content: [{ type: 'text', text: 'Describe this image too.' }, { type: 'image_url', image_url: { url: 'https://example.com/image.png', detail: 'high' } }] },
  ],
  tools: [{ type: 'function', function: { name: 'weather', description: 'Fetch the weather', parameters: schema, strict: true } }],
  tool_choice: { type: 'function', function: { name: 'weather' } }, parallel_tool_calls: false,
  response_format: { type: 'json_schema', json_schema: { name: 'answer', description: 'A weather answer', schema, strict: true } },
  reasoning_effort: 'high', verbosity: 'low', max_tokens: 512, max_completion_tokens: 512,
  temperature: 0.2, top_p: 0.9, n: 1, frequency_penalty: 0, presence_penalty: 0,
  logprobs: false, top_logprobs: 0, logit_bias: {}, stop: null, seed: null,
};

describe('common SDK request compatibility', () => {
  it('round trips a complete Chat SDK body through Responses without losing supported semantics', () => {
    const original = structuredClone(chat);
    const warnings: string[] = [];
    const responses = convertRequest(chat, 'openai', 'responses', 'selected-model', true, warnings);
    expect(responses).toMatchObject({
      ...shared, model: 'selected-model', stream: true, max_output_tokens: 512, temperature: 0.2, top_p: 0.9,
      reasoning: { effort: 'high' }, text: { verbosity: 'low', format: { type: 'json_schema', name: 'answer', description: 'A weather answer', schema, strict: true } },
      tools: [{ type: 'function', name: 'weather', parameters: schema, strict: true }],
      tool_choice: { type: 'function', name: 'weather' }, parallel_tool_calls: false,
    });
    expect(responses.input).toEqual([
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Return JSON.' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Weather in Paris?' }] },
      { type: 'function_call', call_id: 'call_weather_1', name: 'weather', arguments: '{ "city": "Paris", "units": null }' },
      { type: 'function_call_output', call_id: 'call_weather_1', output: '{"temperature":22}' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Describe this image too.' }, { type: 'input_image', image_url: 'https://example.com/image.png', detail: 'high' }] },
    ]);
    const returned = convertRequest(responses, 'responses', 'openai', 'selected-model', true, warnings);
    expect(returned).toMatchObject({
      ...shared, model: 'selected-model', stream_options: { include_usage: true }, max_completion_tokens: 512,
      response_format: chat.response_format, reasoning_effort: 'high', verbosity: 'low', tools: chat.tools,
      tool_choice: chat.tool_choice, parallel_tool_calls: false, temperature: 0.2, top_p: 0.9,
    });
    expect(returned.messages[2].tool_calls).toEqual(chat.messages[2].tool_calls);
    expect(returned.messages[3]).toEqual({ role: 'tool', tool_call_id: 'call_weather_1', content: '{"temperature":22}' });
    expect(returned.messages.at(-1)).toEqual(chat.messages.at(-1));
    expect(warnings).toEqual([]);
    expect(chat).toEqual(original);
  });

  it('maps Responses SDK history, empty defaults and verbosity to Chat', () => {
    const body = {
      ...shared, input: [
        { type: 'message', id: 'msg_1', status: 'completed', role: 'assistant', phase: null, content: [{ type: 'output_text', text: 'Checking.', annotations: [], logprobs: [] }] },
        { type: 'function_call', id: 'fc_item_1', status: 'completed', call_id: 'call_1', name: 'weather', arguments: '{"city":"Paris"}' },
        { type: 'function_call_output', id: 'item_output_1', status: 'completed', call_id: 'call_1', output: [{ type: 'input_text', text: '{"temperature":22}' }] },
      ], instructions: 'Answer briefly.', stream: true, background: false, include: [], top_logprobs: 0,
      reasoning: { effort: 'minimal', summary: null, generate_summary: null }, text: { format: { type: 'text' }, verbosity: 'medium' },
      tools: [{ type: 'function', name: 'weather', description: null, parameters: schema, strict: null }],
      tool_choice: 'auto', max_output_tokens: 128, truncation: 'disabled', temperature: null, top_p: null, parallel_tool_calls: null,
    };
    const converted = convertRequest(body, 'responses', 'openai', 'selected-model', true);
    expect(converted).toMatchObject({ ...shared, model: 'selected-model', reasoning_effort: 'minimal', verbosity: 'medium', max_completion_tokens: 128, response_format: { type: 'text' } });
    expect(converted.messages).toEqual([
      { role: 'system', content: 'Answer briefly.' },
      { role: 'assistant', content: 'Checking.', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'weather', arguments: '{"city":"Paris"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '{"temperature":22}' },
    ]);
    expect(converted.tools).toEqual([{ type: 'function', function: { name: 'weather', parameters: schema } }]);
    expect(converted).not.toHaveProperty('temperature');
    expect(converted).not.toHaveProperty('top_p');
    expect(converted).not.toHaveProperty('parallel_tool_calls');
  });

  it.each(['openai', 'responses'] as const)('accepts nullable %s JSON schema settings without inventing strictness', protocol => {
    const format = { name: 'answer', schema, description: null, strict: null };
    const body = protocol === 'openai'
      ? { messages: [{ role: 'user', content: 'Hello' }], response_format: { type: 'json_schema', json_schema: format } }
      : { input: 'Hello', text: { format: { type: 'json_schema', ...format }, verbosity: null } };
    const converted = convertRequest(body, protocol, protocol === 'openai' ? 'responses' : 'openai', 'selected-model', false);
    const result = protocol === 'openai' ? converted.text.format : converted.response_format.json_schema;
    expect(result).toMatchObject({ name: 'answer', schema });
    expect(result).not.toHaveProperty('strict');
    expect(result).not.toHaveProperty('description');
  });

  it('preserves provided Responses reasoning controls and assistant phase in compatible Chat extensions', () => {
    const converted = convertRequest({
      messages: [{ role: 'assistant', phase: 'commentary', content: 'Checking.' }, { role: 'user', content: 'Continue.' }],
      reasoning_effort: 'high', reasoning: { effort: 'high', generate_summary: 'detailed' },
    }, 'openai', 'responses', 'selected-model', false);
    expect(converted.reasoning).toEqual({ effort: 'high', summary: 'detailed' });
    expect(converted.input[0]).toEqual({ type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Checking.', annotations: [] }] });
  });

  it.each(['responses', 'anthropic', 'gemini'] as const)('accepts harmless Chat SDK defaults for %s', protocol => {
    const converted = convertRequest({
      messages: [{ role: 'user', content: 'Hello', tool_calls: [] }, { role: 'assistant', content: 'Hi', reasoning_content: '', reasoning: [], refusal: '', annotations: [], tool_calls: null }],
      metadata: {}, store: null, frequency_penalty: 0, presence_penalty: 0, logprobs: false, top_logprobs: 0, logit_bias: {},
      n: 1, stream_options: { include_usage: true }, reasoning_effort: null, verbosity: null, modalities: ['text'],
    }, 'openai', protocol, 'selected-model', false);
    expect(converted).toBeDefined();
    expect(JSON.stringify(converted)).toContain('Hello');
    expect(JSON.stringify(converted)).toContain('Hi');
  });

  it.each(['anthropic', 'gemini'] as const)('reports omitted OpenAI bookkeeping when converting to %s without exposing values', protocol => {
    const warnings: string[] = [];
    const body = { ...shared, prompt_cache_retention: null, messages: [{ role: 'user', content: 'Hello' }] };
    const converted = convertRequest(body, 'openai', protocol, 'selected-model', false, warnings);
    for (const field of ['metadata', 'user', 'safety_identifier', 'prompt_cache_key', 'service_tier']) {
      expect(converted).not.toHaveProperty(field);
      expect(warnings).toContain(`${field} omitted: ${protocol} has no equivalent request field`);
    }
    expect(warnings).toHaveLength(5);
    expect(warnings.join(' ')).not.toContain('test-user');
    expect(warnings.join(' ')).not.toContain('test-cache');
    expect(warnings.join(' ')).not.toContain('sdk-fixture');
  });

  it('preserves an assistant phase even when the history message only calls a tool', () => {
    const converted = convertRequest({
      messages: [{ ...chat.messages[2], phase: 'commentary' }],
    }, 'openai', 'responses', 'selected-model', false);
    expect(converted.input[0]).toEqual({ type: 'message', role: 'assistant', phase: 'commentary', content: [] });
    expect(converted.input[1]).toMatchObject({ type: 'function_call', call_id: 'call_weather_1' });
  });

  it('tolerates explicitly disabled strict tool enforcement and zero logit biases for Gemini', () => {
    const converted = convertRequest({
      messages: [{ role: 'user', content: 'Hello' }], tools: [{ type: 'function', function: { name: 'weather', parameters: schema, strict: false } }],
      logit_bias: { 123: 0 },
    }, 'openai', 'gemini', 'selected-model', false);
    expect(converted.tools[0].functionDeclarations[0]).toMatchObject({ name: 'weather', parametersJsonSchema: schema });
  });
});

describe('compatibility keeps meaningful unsupported settings explicit', () => {
  const chatCases: [string, Record<string, unknown>][] = [
    ['frequency_penalty', { frequency_penalty: 0.5 }], ['presence_penalty', { presence_penalty: -0.5 }],
    ['logprobs', { logprobs: true }], ['top_logprobs', { top_logprobs: 1 }], ['logit_bias', { logit_bias: { 123: 10 } }],
    ['storage', { store: true }], ['n=1', { n: 2 }], ['max_tokens', { max_tokens: 1, max_completion_tokens: 2 }],
    ['reasoning.effort', { reasoning_effort: 'high', reasoning: { effort: 'low' } }],
    ['reasoning.summary', { reasoning: { summary: 'auto', generate_summary: 'detailed' } }],
    ['provider_debug', { provider_debug: { ignored: true } }],
    ['modalities', { modalities: ['text', 'audio'] }],
  ];
  it.each(chatCases)('does not silently drop Chat %s', (field, parameters) => {
    expect(() => convertRequest({ messages: [{ role: 'user', content: 'Hello' }], ...parameters }, 'openai', 'responses', 'selected-model', false)).toThrow(field);
  });

  const responseCases: [string, Record<string, unknown>][] = [
    ['previous_response_id', { previous_response_id: 'resp_previous' }], ['conversation', { conversation: 'conv_1' }],
    ['reasoning.summary', { reasoning: { effort: 'high', summary: 'auto' } }], ['reasoning.summary', { reasoning: { generate_summary: 'concise' } }],
    ['include', { include: ['reasoning.encrypted_content'] }], ['background', { background: true }],
    ['truncation', { truncation: 'auto' }], ['storage', { store: true }],
  ];
  it.each(responseCases)('does not silently drop Responses %s', (field, parameters) => {
    expect(() => convertRequest({ input: 'Hello', ...parameters }, 'responses', 'openai', 'selected-model', false)).toThrow(field);
  });

  it.each(['commentary', 'final_answer'])('rejects losing Responses assistant phase %s', phase => {
    expect(() => convertRequest({ input: [{ role: 'assistant', phase, content: 'Answer.' }] }, 'responses', 'openai', 'selected-model', false)).toThrow('message.phase');
  });

  it.each(['anthropic', 'gemini'] as const)('keeps retention and generation controls explicit for %s', protocol => {
    for (const [field, parameters] of [
      ['prompt_cache_retention', { prompt_cache_retention: 'in_memory' }],
      ['reasoning_effort', { reasoning_effort: 'low' }], ['text.verbosity', { verbosity: 'low' }],
    ] as const) expect(() => convertRequest({ messages: [{ role: 'user', content: 'Hello' }], ...parameters }, 'openai', protocol, 'selected-model', false)).toThrow(field);
  });

  it.each([
    { reasoning_content: 'actual history reasoning' }, { reasoning: 'actual history reasoning' },
    { annotations: [{ type: 'url_citation', url: 'https://example.com' }] }, { refusal: 'Declined.' },
  ])('rejects meaningful assistant metadata instead of deleting it', attributes => {
    expect(() => convertRequest({ messages: [{ role: 'assistant', content: 'Answer.', ...attributes }] }, 'openai', 'responses', 'selected-model', false)).toThrow(ProtocolConversionError);
  });

  it('does not remove unknown function-choice or structured-output controls', () => {
    expect(() => convertRequest({ messages: [{ role: 'user', content: 'Hello' }], tool_choice: { type: 'function', function: { name: 'weather', unexpected: true } } }, 'openai', 'responses', 'selected-model', false)).toThrow('tool_choice.function.unexpected');
    expect(() => convertRequest({ messages: [{ role: 'user', content: 'Hello' }], response_format: { type: 'json_schema', json_schema: { name: 'answer', schema, unexpected: true } } }, 'openai', 'responses', 'selected-model', false)).toThrow('response_format.json_schema.unexpected');
    expect(() => convertRequest({ messages: [{ role: 'user', content: 'Hello' }], tools: [{ name: 'weather', input_schema: schema, strict: 'true' }] }, 'anthropic', 'gemini', 'selected-model', false)).toThrow('tool strict must be a boolean');
  });

  it('does not expose rejected history content in conversion diagnostics', () => {
    try {
      convertRequest({ messages: [{ role: 'assistant', content: 'Answer.', reasoning_content: 'private-history-fixture' }] }, 'openai', 'responses', 'selected-model', false);
      expect.fail('Expected unsupported reasoning history to be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolConversionError);
      expect((error as Error).message).toContain('reasoning_content');
      expect((error as Error).message).not.toContain('private-history-fixture');
    }
  });

  it.each(['annotations', 'logprobs'])('does not treat malformed text %s objects as empty', field => {
    expect(() => convertRequest({ input: [{ role: 'assistant', content: [{ type: 'output_text', text: 'Hello', [field]: {} }] }] }, 'responses', 'openai', 'selected-model', false)).toThrow(`text.${field} must be an array`);
  });

  it.each(['openai', 'responses', 'anthropic', 'gemini'] as Protocol[])('leaves same-protocol %s state untouched', protocol => {
    const body = { previous_response_id: 'state', arbitrary_provider_field: true };
    const warnings: string[] = [];
    expect(convertRequest(body, protocol, protocol, 'selected-model', true, warnings)).toBe(body);
    expect(warnings).toEqual([]);
  });
});
