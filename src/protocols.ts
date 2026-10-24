/**
 * Stateless, explicit protocol conversion. Same-protocol requests are untouched.
 * Responses/Gemini field mappings adapted from cloudflare-llm-gateway (MIT).
 * See THIRD_PARTY_NOTICES.md. Unsupported semantics are rejected, never filtered.
 */
import type { Protocol } from './types';

type Obj = Record<string, any>;
type Part = { type: 'text'; text: string } | { type: 'image'; url: string; detail?: string; mime?: string };
export type Call = { id: string; name: string; arguments: string };
type Message = { role: string; content: Part[]; calls?: Call[]; callId?: string; name?: string; isError?: boolean; phase?: string };
type Tool = { name: string; description?: string; parameters: Obj; strict?: boolean };
type ChatRequest = {
  messages: Message[]; tools?: Tool[]; choice?: any; maxTokens?: number;
  temperature?: number; topP?: number; stop?: string[]; parallel?: boolean;
  format?: Obj; effort?: string; summary?: string; verbosity?: string; seed?: number; topK?: number; openai?: Obj;
};
type Usage = { input: number; output: number; total: number; cached: number; cacheWrite: number; reasoning: number };
export type ChatResponse = { id: string; created: number; content: Part[]; calls: Call[]; refusal?: string; finish: string; usage?: Usage };

export class ProtocolConversionError extends Error {
  readonly code = 'unsupported_protocol_conversion';
  constructor(message: string, readonly status = 400) { super(message); this.name = 'ProtocolConversionError'; }
}
function fail(message: string): never { throw new ProtocolConversionError(message); }
function bad(message: string): never { throw new ProtocolConversionError(message, 502); }
function object(value: any, path: string): Obj {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${path} must be an object`);
  return value;
}
function array(value: any, path: string): any[] {
  if (!Array.isArray(value)) fail(`${path} must be an array`);
  return value;
}
function string(value: any, path: string): string {
  if (typeof value !== 'string') fail(`${path} must be a string`);
  return value;
}
function nonempty(value: any, path: string): string {
  const s = string(value, path); if (!s) fail(`${path} must not be empty`); return s;
}
function keys(value: Obj, allowed: string[], path: string) {
  for (const key of Object.keys(value)) if (value[key] !== undefined && value[key] !== null && !allowed.includes(key)) {
    fail(`Cross-protocol conversion does not support ${path}.${key}; use a channel with the same protocol`);
  }
}
const sharedOpenAIKeys = ['metadata', 'user', 'safety_identifier', 'prompt_cache_key', 'prompt_cache_retention', 'service_tier', 'store'];
function optionalString(value: any, path: string): string | undefined { return value == null ? undefined : string(value, path); }
function optionalBoolean(value: any, path: string): boolean | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'boolean') fail(`${path} must be a boolean`);
  return value;
}
function emptyArray(value: any, path: string) {
  if (value != null && array(value, path).length) fail(`${path} cannot be preserved across these protocols`);
}
function defaultValue(value: any, expected: any, path: string) {
  if (value != null && value !== expected) fail(`${path} has no exact cross-protocol equivalent for a non-default value`);
}
function sharedOpenAIOptions(body: Obj): Obj {
  const options: Obj = {};
  if (body.metadata != null) {
    const metadata = object(body.metadata, 'metadata');
    for (const value of Object.values(metadata)) string(value, 'metadata value');
    options.metadata = metadata;
  }
  for (const field of sharedOpenAIKeys.filter(field => field !== 'metadata' && field !== 'store')) {
    if (body[field] != null) options[field] = string(body[field], field);
  }
  const store = optionalBoolean(body.store, 'store');
  if (store === true) fail('Response storage cannot be preserved across protocols');
  if (store === false) options.store = false;
  return options;
}
function readReasoning(value: any, effort?: any): { effort?: string; summary?: string } {
  const reasoning = value == null ? {} : object(value, 'reasoning');
  keys(reasoning, ['effort', 'summary', 'generate_summary'], 'reasoning');
  if (reasoning.effort != null && effort != null && reasoning.effort !== effort) fail('Conflicting reasoning.effort and reasoning_effort');
  if (reasoning.summary != null && reasoning.generate_summary != null && reasoning.summary !== reasoning.generate_summary) fail('Conflicting reasoning.summary and reasoning.generate_summary');
  return { effort: optionalString(reasoning.effort ?? effort, 'reasoning.effort'), summary: optionalString(reasoning.summary ?? reasoning.generate_summary, 'reasoning.summary') };
}
function readFormat(value: any, responses = false): Obj | undefined {
  if (value == null) return undefined;
  const format = object(value, responses ? 'text.format' : 'response_format');
  if (format.type === 'text' || format.type === 'json_object') { keys(format, ['type'], 'response format'); return { type: format.type }; }
  if (format.type !== 'json_schema') fail('Unsupported structured output format');
  keys(format, responses ? ['type', 'name', 'schema', 'strict', 'description'] : ['type', 'json_schema'], 'response format');
  const schema = responses ? format : object(format.json_schema, 'response_format.json_schema');
  if (!responses) keys(schema, ['name', 'schema', 'strict', 'description'], 'response_format.json_schema');
  return { type: 'json_schema', json_schema: clean({ name: nonempty(schema.name, 'JSON schema name'), schema: object(schema.schema, 'JSON schema'), strict: optionalBoolean(schema.strict, 'JSON schema strict'), description: optionalString(schema.description, 'JSON schema description') }) };
}
function readPhase(value: any, role: string): string | undefined {
  if (value == null) return undefined;
  if (role !== 'assistant' || !['commentary', 'final_answer'].includes(value)) fail('message.phase requires an assistant commentary or final_answer message');
  return value;
}
function args(value: any, path: string): string {
  if (typeof value === 'string') return value;
  object(value ?? {}, path); return JSON.stringify(value ?? {});
}
function argsObject(value: string, path: string): Obj {
  let parsed: any;
  try { parsed = JSON.parse(value || '{}'); } catch { fail(`${path} contains invalid JSON; it cannot be converted to an object`); }
  return object(parsed, path);
}
function dataImage(url: string) { return /^data:(image\/[a-z0-9.+-]+);base64,([a-zA-Z0-9+/=\s]+)$/i.exec(url); }
function image(url: any, detail?: any, mime?: any): Part {
  nonempty(url, 'image URL');
  if (!/^https?:\/\//i.test(url) && !dataImage(url)) fail('Cross-protocol images require an HTTP(S) URL or an image base64 data URL; provider file IDs cannot be transferred');
  if (mime && !String(mime).startsWith('image/')) fail(`Unsupported media type ${mime}; only images are supported across protocols`);
  if (detail && !['auto', 'low', 'high', 'original'].includes(detail)) fail(`Unsupported image detail ${detail}`);
  return { type: 'image', url, ...(detail ? { detail } : {}), ...(mime ? { mime } : {}) };
}
function textParts(value: any, path: string): Part[] {
  if (value == null) return [];
  if (typeof value === 'string') return [{ type: 'text', text: value }];
  return array(value, path).map((p, i) => {
    object(p, `${path}[${i}]`);
    if (p.type === 'text' || p.type === 'input_text' || p.type === 'output_text') {
      keys(p, ['type', 'text', 'annotations', 'logprobs'], `${path}[${i}]`);
      if (p.annotations != null) { array(p.annotations, 'text.annotations'); if (p.annotations.length) fail('Cross-protocol annotated/cited text is not supported'); }
      if (p.logprobs != null) { array(p.logprobs, 'text.logprobs'); if (p.logprobs.length) fail('Cross-protocol token log probabilities are not supported'); }
      return { type: 'text', text: string(p.text, `${path}[${i}].text`) };
    }
    if (p.type === 'image_url') {
      keys(p, ['type', 'image_url'], `${path}[${i}]`); const source = object(p.image_url, 'image_url'); keys(source, ['url', 'detail'], 'image_url');
      return image(source.url, source.detail);
    }
    if (p.type === 'input_image') {
      keys(p, ['type', 'image_url', 'detail'], `${path}[${i}]`); return image(p.image_url, p.detail);
    }
    fail(`Unsupported cross-protocol content type ${String(p.type)}`);
  });
}
function onlyText(parts: Part[], path: string): string {
  if (parts.some(p => p.type !== 'text')) fail(`${path} only supports text across these protocols`);
  return parts.map(p => p.type === 'text' ? p.text : '').join('');
}
function chatContent(parts: Part[]): any {
  if (parts.every(p => p.type === 'text')) return onlyText(parts, 'content');
  return parts.map(p => p.type === 'text' ? p : { type: 'image_url', image_url: { url: p.url, ...(p.detail ? { detail: p.detail } : {}) } });
}
function outputText(m: Message): string {
  const text = onlyText(m.content, 'tool result');
  return m.isError ? JSON.stringify({ is_error: true, content: text }) : text;
}
function validateRole(role: any): string {
  if (!['system', 'developer', 'user', 'assistant', 'tool'].includes(role)) fail(`Unsupported message role ${String(role)}`);
  return role;
}
function readCalls(value: any, path: string): Call[] {
  return array(value, path).map((t, i) => {
    object(t, path); keys(t, ['id', 'type', 'function'], `${path}[${i}]`);
    if (t.type !== 'function') fail('Only function tool calls can be converted');
    const f = object(t.function, `${path}[${i}].function`); keys(f, ['name', 'arguments'], 'tool function');
    return { id: nonempty(t.id, 'tool call id'), name: nonempty(f.name, 'function name'), arguments: args(f.arguments ?? '{}', 'function arguments') };
  });
}
function readChat(body: Obj): ChatRequest {
  keys(body, ['model', 'messages', 'stream', 'max_tokens', 'max_completion_tokens', 'temperature', 'top_p', 'stop', 'tools', 'tool_choice', 'parallel_tool_calls', 'response_format', 'reasoning_effort', 'reasoning', 'verbosity', 'seed', 'n', 'stream_options', 'frequency_penalty', 'presence_penalty', 'logprobs', 'top_logprobs', 'logit_bias', 'modalities', ...sharedOpenAIKeys], 'openai');
  if (body.n != null && body.n !== 1) fail('Cross-protocol conversion supports n=1 only');
  if (body.stream_options != null) {
    keys(object(body.stream_options, 'stream_options'), ['include_usage'], 'stream_options');
    optionalBoolean(body.stream_options.include_usage, 'stream_options.include_usage');
  }
  defaultValue(body.frequency_penalty, 0, 'frequency_penalty');
  defaultValue(body.presence_penalty, 0, 'presence_penalty');
  defaultValue(body.logprobs, false, 'logprobs');
  defaultValue(body.top_logprobs, 0, 'top_logprobs');
  if (body.logit_bias != null && Object.values(object(body.logit_bias, 'logit_bias')).some(value => value !== 0)) fail('logit_bias has no exact cross-protocol equivalent');
  if (body.modalities != null && array(body.modalities, 'modalities').some(modality => modality !== 'text')) fail('Non-text output modalities cannot be preserved across these protocols');
  if (body.max_tokens != null && body.max_completion_tokens != null && body.max_tokens !== body.max_completion_tokens) fail('Conflicting max_tokens and max_completion_tokens');
  const messages: Message[] = array(body.messages, 'messages').map((m, i) => {
    object(m, `messages[${i}]`); keys(m, ['role', 'content', 'tool_calls', 'tool_call_id', 'name', 'reasoning_content', 'reasoning', 'annotations', 'refusal', 'phase'], `messages[${i}]`);
    const role = validateRole(m.role);
    emptyArray(m.annotations, `messages[${i}].annotations`);
    defaultValue(m.reasoning_content, '', `messages[${i}].reasoning_content`);
    if (Array.isArray(m.reasoning)) emptyArray(m.reasoning, `messages[${i}].reasoning`);
    else defaultValue(m.reasoning, '', `messages[${i}].reasoning`);
    defaultValue(m.refusal, '', `messages[${i}].refusal`);
    if (m.name && role !== 'tool') fail('Named chat participants have no equivalent in the target protocol');
    const calls = m.tool_calls == null ? undefined : readCalls(m.tool_calls, 'tool_calls');
    if (calls?.length && role !== 'assistant') fail('tool_calls must belong to an assistant message');
    return { role, content: textParts(m.content, 'message.content'), phase: readPhase(m.phase, role), ...(calls ? { calls } : {}), ...(role === 'tool' ? { callId: nonempty(m.tool_call_id, 'tool_call_id'), name: m.name } : {}) };
  });
  const tools = body.tools == null ? undefined : array(body.tools, 'tools').map(t => {
    object(t, 'tool'); keys(t, ['type', 'function'], 'tool'); if (t.type !== 'function') fail('Built-in and custom non-function tools require same-protocol routing');
    const f = object(t.function, 'tool.function'); keys(f, ['name', 'description', 'parameters', 'strict'], 'tool.function');
    return { name: nonempty(f.name, 'tool name'), description: optionalString(f.description, 'tool description'), parameters: object(f.parameters ?? { type: 'object', properties: {} }, 'tool parameters'), strict: optionalBoolean(f.strict, 'tool strict') };
  });
  return { messages, tools, choice: readChoice(body.tool_choice, 'openai'), maxTokens: body.max_completion_tokens ?? body.max_tokens ?? undefined, temperature: body.temperature ?? undefined, topP: body.top_p ?? undefined, stop: normalizeStop(body.stop), parallel: optionalBoolean(body.parallel_tool_calls, 'parallel_tool_calls'), format: readFormat(body.response_format), ...readReasoning(body.reasoning, body.reasoning_effort), verbosity: optionalString(body.verbosity, 'verbosity'), seed: body.seed ?? undefined, openai: sharedOpenAIOptions(body) };
}
function readResponses(body: Obj): ChatRequest {
  keys(body, ['model', 'input', 'instructions', 'stream', 'max_output_tokens', 'temperature', 'top_p', 'tools', 'tool_choice', 'parallel_tool_calls', 'text', 'reasoning', 'truncation', 'include', 'top_logprobs', 'background', ...sharedOpenAIKeys], 'responses');
  emptyArray(body.include, 'include');
  defaultValue(body.top_logprobs, 0, 'top_logprobs');
  defaultValue(body.background, false, 'background');
  if (body.truncation && body.truncation !== 'disabled') fail('Automatic Responses truncation cannot be preserved across protocols');
  const messages: Message[] = [];
  if (body.instructions != null) messages.push({ role: 'system', content: [{ type: 'text', text: string(body.instructions, 'instructions') }] });
  if (typeof body.input === 'string') messages.push({ role: 'user', content: [{ type: 'text', text: body.input }] });
  else for (const item of array(body.input ?? [], 'input')) {
    object(item, 'input item');
    if (item.type === 'function_call') {
      keys(item, ['type', 'id', 'call_id', 'name', 'arguments', 'status'], 'function_call');
      const call = { id: nonempty(item.call_id, 'call_id'), name: nonempty(item.name, 'function name'), arguments: args(item.arguments ?? '{}', 'function arguments') };
      const last = messages.at(-1);
      if (last?.role === 'assistant') (last.calls ??= []).push(call);
      else messages.push({ role: 'assistant', content: [], calls: [call] });
    } else if (item.type === 'function_call_output') {
      keys(item, ['type', 'id', 'call_id', 'output', 'status'], 'function_call_output');
      messages.push({ role: 'tool', callId: nonempty(item.call_id, 'call_id'), content: textParts(item.output, 'function_call_output.output') });
    } else if (item.type == null || item.type === 'message') {
      keys(item, ['type', 'id', 'role', 'content', 'status', 'phase'], 'input message');
      const role = validateRole(item.role ?? 'user'); if (role === 'tool') fail('Responses tool results must use function_call_output');
      messages.push({ role, content: textParts(item.content, 'input.content'), phase: readPhase(item.phase, role) });
    } else fail(`Responses input item ${item.type} cannot be converted; reasoning, references and built-in tool state require same-protocol routing`);
  }
  const tools = body.tools == null ? undefined : array(body.tools, 'tools').map(t => {
    object(t, 'tool'); keys(t, ['type', 'name', 'description', 'parameters', 'strict'], 'tool');
    if (t.type !== 'function') fail('Responses built-in tools require same-protocol routing');
    return { name: nonempty(t.name, 'tool name'), description: optionalString(t.description, 'tool description'), parameters: object(t.parameters ?? { type: 'object', properties: {} }, 'tool parameters'), strict: optionalBoolean(t.strict, 'tool strict') };
  });
  let format: Obj | undefined;
  if (body.text != null) {
    keys(object(body.text, 'text'), ['format', 'verbosity'], 'text');
    format = readFormat(body.text.format, true);
  }
  return { messages, tools, choice: readChoice(body.tool_choice, 'responses'), maxTokens: body.max_output_tokens ?? undefined, temperature: body.temperature ?? undefined, topP: body.top_p ?? undefined, parallel: optionalBoolean(body.parallel_tool_calls, 'parallel_tool_calls'), format, ...readReasoning(body.reasoning), verbosity: optionalString(body.text?.verbosity, 'text.verbosity'), openai: sharedOpenAIOptions(body) };
}
function anthropicPart(p: Obj): Part {
  if (p.type === 'text') { keys(p, ['type', 'text', 'citations'], 'anthropic text'); if (p.citations?.length) fail('Cross-protocol cited text is not supported'); return { type: 'text', text: string(p.text, 'text') }; }
  if (p.type !== 'image') fail(`Anthropic content type ${p.type} cannot be converted`);
  keys(p, ['type', 'source'], 'anthropic image'); const s = object(p.source, 'image.source');
  if (s.type === 'base64') { keys(s, ['type', 'media_type', 'data'], 'image.source'); return image(`data:${nonempty(s.media_type, 'media_type')};base64,${nonempty(s.data, 'image data')}`); }
  if (s.type === 'url') { keys(s, ['type', 'url'], 'image.source'); return image(s.url); }
  fail('Provider-specific image file references cannot be converted');
}
function readAnthropic(body: Obj): ChatRequest {
  keys(body, ['model', 'messages', 'system', 'max_tokens', 'temperature', 'top_p', 'top_k', 'stop_sequences', 'tools', 'tool_choice', 'stream'], 'anthropic');
  const messages: Message[] = [];
  if (body.system != null) {
    const content = typeof body.system === 'string' ? [{ type: 'text' as const, text: body.system }] : array(body.system, 'system').map(anthropicPart);
    onlyText(content, 'system'); messages.push({ role: 'system', content });
  }
  for (const m of array(body.messages, 'messages')) {
    object(m, 'message'); keys(m, ['role', 'content'], 'message');
    if (!['user', 'assistant'].includes(m.role)) fail('Anthropic message role must be user or assistant');
    if (typeof m.content === 'string') { messages.push({ role: m.role, content: [{ type: 'text', text: m.content }] }); continue; }
    let current: Message = { role: m.role, content: [] };
    const flush = () => { if (current.content.length || current.calls?.length) messages.push(current); current = { role: m.role, content: [] }; };
    for (const p of array(m.content, 'message.content')) {
      object(p, 'content block');
      if (p.type === 'tool_use') {
        if (m.role !== 'assistant') fail('tool_use must be in assistant content');
        keys(p, ['type', 'id', 'name', 'input'], 'tool_use');
        (current.calls ??= []).push({ id: nonempty(p.id, 'tool_use.id'), name: nonempty(p.name, 'tool_use.name'), arguments: args(p.input ?? {}, 'tool_use.input') });
      } else if (p.type === 'tool_result') {
        if (m.role !== 'user') fail('tool_result must be in user content');
        keys(p, ['type', 'tool_use_id', 'content', 'is_error'], 'tool_result'); flush();
        const content = typeof p.content === 'string' ? [{ type: 'text' as const, text: p.content }] : array(p.content ?? [], 'tool_result.content').map(anthropicPart);
        onlyText(content, 'tool_result.content');
        messages.push({ role: 'tool', callId: nonempty(p.tool_use_id, 'tool_use_id'), content, isError: p.is_error === true });
      } else current.content.push(anthropicPart(p));
    }
    flush();
  }
  const tools = body.tools == null ? undefined : array(body.tools, 'tools').map(t => {
    object(t, 'tool'); keys(t, ['name', 'description', 'input_schema', 'type', 'strict'], 'tool');
    if (t.type && t.type !== 'custom') fail('Anthropic server/built-in tools require same-protocol routing');
    return { name: nonempty(t.name, 'tool.name'), description: t.description, parameters: object(t.input_schema, 'input_schema'), strict: optionalBoolean(t.strict, 'tool strict') };
  });
  const choice = readChoice(body.tool_choice, 'anthropic');
  return { messages, tools, choice, maxTokens: body.max_tokens, temperature: body.temperature, topP: body.top_p, topK: body.top_k, stop: normalizeStop(body.stop_sequences), parallel: body.tool_choice?.disable_parallel_tool_use == null ? undefined : !body.tool_choice.disable_parallel_tool_use };
}
function geminiPart(p: Obj): Part {
  keys(p, ['text', 'inlineData', 'fileData'], 'gemini part');
  if (typeof p.text === 'string') return { type: 'text', text: p.text };
  if (p.inlineData) { const s = object(p.inlineData, 'inlineData'); keys(s, ['mimeType', 'data'], 'inlineData'); return image(`data:${s.mimeType};base64,${s.data}`); }
  if (p.fileData) { const s = object(p.fileData, 'fileData'); keys(s, ['mimeType', 'fileUri'], 'fileData'); return image(s.fileUri, undefined, s.mimeType); }
  fail('Unsupported Gemini content part');
}
function readGemini(body: Obj): ChatRequest {
  keys(body, ['model', 'contents', 'systemInstruction', 'generationConfig', 'tools', 'toolConfig'], 'gemini');
  const messages: Message[] = [];
  if (body.systemInstruction) {
    const sys = object(body.systemInstruction, 'systemInstruction'); keys(sys, ['role', 'parts'], 'systemInstruction');
    const content = array(sys.parts, 'systemInstruction.parts').map(geminiPart); onlyText(content, 'systemInstruction'); messages.push({ role: 'system', content });
  }
  let sequence = 0; const pending: Call[] = [];
  for (const m of array(body.contents, 'contents')) {
    object(m, 'content'); keys(m, ['role', 'parts'], 'content');
    if (m.role && !['model', 'user'].includes(m.role)) fail(`Invalid Gemini content role ${m.role}`);
    const role = m.role === 'model' ? 'assistant' : 'user'; let current: Message = { role, content: [] };
    const flush = () => { if (current.content.length || current.calls?.length) messages.push(current); current = { role, content: [] }; };
    for (const p of array(m.parts, 'parts')) {
      object(p, 'part');
      if (p.functionCall) {
        keys(p, ['functionCall'], 'functionCall part'); if (role !== 'assistant') fail('Gemini functionCall must have model role');
        const f = object(p.functionCall, 'functionCall'); keys(f, ['name', 'args', 'id'], 'functionCall');
        const call = { id: f.id ?? `call_${sequence++}`, name: nonempty(f.name, 'functionCall.name'), arguments: args(f.args ?? {}, 'functionCall.args') };
        pending.push(call); (current.calls ??= []).push(call);
      } else if (p.functionResponse) {
        keys(p, ['functionResponse'], 'functionResponse part'); if (role !== 'user') fail('Gemini functionResponse must have user role');
        const f = object(p.functionResponse, 'functionResponse'); keys(f, ['name', 'response', 'id'], 'functionResponse'); flush();
        const name = nonempty(f.name, 'functionResponse.name');
        const idx = pending.findIndex(c => f.id ? c.id === f.id : c.name === name);
        if (idx < 0) fail(`Cannot correlate Gemini functionResponse ${name} with a preceding functionCall`);
        const [call] = pending.splice(idx, 1); if (call.name !== name) fail('Gemini tool result name/id mismatch');
        messages.push({ role: 'tool', callId: call.id, name, content: [{ type: 'text', text: JSON.stringify(object(f.response ?? {}, 'functionResponse.response')) }] });
      } else current.content.push(geminiPart(p));
    }
    flush();
  }
  const config = object(body.generationConfig ?? {}, 'generationConfig');
  keys(config, ['temperature', 'topP', 'topK', 'maxOutputTokens', 'stopSequences', 'candidateCount', 'responseMimeType', 'responseSchema', 'responseJsonSchema', 'seed'], 'generationConfig');
  if (config.candidateCount != null && config.candidateCount !== 1) fail('Cross-protocol conversion supports one candidate only');
  if (config.responseSchema && config.responseJsonSchema) fail('Specify only one Gemini response schema');
  let format: Obj | undefined;
  if (config.responseMimeType && config.responseMimeType !== 'text/plain' && config.responseMimeType !== 'application/json') fail('Only text/plain and application/json output can be converted');
  if (config.responseSchema || config.responseJsonSchema) format = { type: 'json_schema', json_schema: { name: 'response', schema: schemaToJSON(config.responseJsonSchema ?? config.responseSchema) } };
  else if (config.responseMimeType === 'application/json') format = { type: 'json_object' };
  const tools = body.tools == null ? undefined : array(body.tools, 'tools').flatMap(t => {
    object(t, 'tool'); keys(t, ['functionDeclarations'], 'tool');
    return array(t.functionDeclarations, 'functionDeclarations').map(f => {
      object(f, 'function declaration'); keys(f, ['name', 'description', 'parameters', 'parametersJsonSchema'], 'function declaration');
      if (f.parameters && f.parametersJsonSchema) fail('Specify one Gemini tool parameter schema');
      return { name: nonempty(f.name, 'function name'), description: f.description, parameters: schemaToJSON(f.parametersJsonSchema ?? f.parameters ?? { type: 'object', properties: {} }) };
    });
  });
  if (body.toolConfig) keys(object(body.toolConfig, 'toolConfig'), ['functionCallingConfig'], 'toolConfig');
  return { messages, tools, choice: readChoice(body.toolConfig?.functionCallingConfig, 'gemini'), maxTokens: config.maxOutputTokens, temperature: config.temperature, topP: config.topP, topK: config.topK, stop: normalizeStop(config.stopSequences), format, seed: config.seed };
}
function schemaToJSON(value: any): any {
  if (Array.isArray(value)) return value.map(schemaToJSON);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === 'type' && typeof v === 'string' ? v.toLowerCase() : schemaToJSON(v)]));
}
function normalizeStop(value: any): string[] | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') return [value];
  return array(value, 'stop').map(s => string(s, 'stop entry'));
}
function readChoice(value: any, protocol: Protocol): any {
  if (value == null) return undefined;
  if (protocol === 'anthropic') {
    object(value, 'tool_choice'); keys(value, ['type', 'name', 'disable_parallel_tool_use'], 'tool_choice');
    if (value.type === 'tool') return { name: nonempty(value.name, 'tool_choice.name') };
    if (value.type === 'any') return 'required';
    if (['auto', 'none'].includes(value.type)) return value.type;
  } else if (protocol === 'gemini') {
    object(value, 'functionCallingConfig'); keys(value, ['mode', 'allowedFunctionNames'], 'functionCallingConfig');
    if (value.allowedFunctionNames?.length) {
      if (value.mode !== 'ANY' || value.allowedFunctionNames.length !== 1) fail('Only a single forced Gemini function name can be converted');
      return { name: nonempty(value.allowedFunctionNames[0], 'allowed function name') };
    }
    if (value.mode === 'ANY') return 'required';
    if (value.mode === 'NONE') return 'none';
    if (!value.mode || value.mode === 'AUTO') return 'auto';
  } else {
    if (['auto', 'none', 'required'].includes(value)) return value;
    object(value, 'tool_choice'); keys(value, protocol === 'openai' ? ['type', 'function'] : ['type', 'name'], 'tool_choice');
    if (value.type === 'function') {
      if (protocol === 'openai') keys(object(value.function, 'tool_choice.function'), ['name'], 'tool_choice.function');
      return { name: nonempty(protocol === 'openai' ? value.function.name : value.name, 'tool choice function name') };
    }
  }
  fail(`Unsupported ${protocol} tool choice`);
}
function toAnthropicPart(p: Part): Obj {
  if (p.type === 'text') return p;
  if (p.detail && p.detail !== 'auto') fail('Image detail hints cannot be preserved in Anthropic requests');
  const data = dataImage(p.url);
  return { type: 'image', source: data ? { type: 'base64', media_type: data[1], data: data[2] } : { type: 'url', url: p.url } };
}
function toGeminiPart(p: Part): Obj {
  if (p.type === 'text') return { text: p.text };
  if (p.detail && p.detail !== 'auto') fail('Image detail hints cannot be preserved in Gemini requests');
  const data = dataImage(p.url);
  return data ? { inlineData: { mimeType: data[1], data: data[2] } } : { fileData: { fileUri: p.url, ...(p.mime ? { mimeType: p.mime } : {}) } };
}
function encodeRequest(c: ChatRequest, to: Protocol, model: string, stream: boolean, warnings: string[]): Obj {
  const names = new Map<string, string>();
  for (const m of c.messages) for (const call of m.calls ?? []) names.set(call.id, call.name);
  if (!c.messages.length) fail('At least one input message is required');
  if (c.effort != null && to !== 'openai' && to !== 'responses') fail(`reasoning_effort has no exact ${to} equivalent`);
  if (c.summary != null && to !== 'responses') fail(`reasoning.summary has no exact ${to} equivalent`);
  if (c.verbosity != null && to !== 'openai' && to !== 'responses') fail(`text.verbosity has no exact ${to} equivalent`);
  if (c.messages.some(message => message.phase != null) && to !== 'responses') fail(`message.phase has no exact ${to} equivalent`);
  if (c.topK != null && to !== 'gemini' && to !== 'anthropic') fail(`top_k has no ${to} equivalent`);
  if (c.seed != null && to !== 'gemini' && to !== 'openai') fail(`seed has no ${to} equivalent`);
  if (c.parallel != null && to === 'gemini') fail('parallel_tool_calls has no exact Gemini equivalent');
  if (c.tools?.some(t => t.strict === true) && to === 'gemini') fail('Strict function schema enforcement has no exact Gemini equivalent');
  if (c.format && !['text', 'json_object', 'json_schema'].includes(c.format.type)) fail('Unsupported structured output format');
  if (c.format && c.format.type !== 'text' && to === 'anthropic') fail('Structured output conversion to Anthropic is not implemented; use same-protocol routing');
  if (to !== 'openai' && to !== 'responses') {
    for (const [field, value] of Object.entries(c.openai ?? {})) {
      if (field === 'store' || value == null || field === 'metadata' && !Object.keys(value).length) continue;
      if (field === 'prompt_cache_retention') fail(`prompt_cache_retention has no exact ${to} data-retention equivalent`);
      warnings.push(`${field} omitted: ${to} has no equivalent request field`);
    }
  }
  if (to === 'openai') {
    const out: Obj = { model, messages: c.messages.map(m => ({ role: m.role, content: m.role === 'tool' ? outputText(m) : m.content.length ? chatContent(m.content) : m.calls?.length ? null : '', ...(m.calls?.length ? { tool_calls: m.calls.map(t => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.arguments } })) } : {}), ...(m.role === 'tool' ? { tool_call_id: m.callId } : {}) })), stream };
    if (stream) out.stream_options = { include_usage: true };
    if (c.tools) out.tools = c.tools.map(t => ({ type: 'function', function: clean({ name: t.name, description: t.description, parameters: t.parameters, strict: t.strict }) }));
    return clean({ ...out, ...c.openai, max_completion_tokens: c.maxTokens, temperature: c.temperature, top_p: c.topP, stop: c.stop, tool_choice: typeof c.choice === 'object' ? { type: 'function', function: { name: c.choice.name } } : c.choice, parallel_tool_calls: c.parallel, response_format: c.format, reasoning_effort: c.effort, verbosity: c.verbosity, seed: c.seed });
  }
  if (to === 'responses') {
    if (c.stop?.length) fail('stop sequences have no Responses equivalent');
    const input: Obj[] = [];
    for (const m of c.messages) {
      if (m.role === 'tool') { input.push({ type: 'function_call_output', call_id: m.callId, output: outputText(m) }); continue; }
      if (m.content.length || m.phase != null) input.push({ type: 'message', role: m.role, ...(m.phase ? { phase: m.phase } : {}), content: m.content.map(p => p.type === 'text' ? { type: m.role === 'assistant' ? 'output_text' : 'input_text', text: p.text, ...(m.role === 'assistant' ? { annotations: [] } : {}) } : m.role === 'assistant' ? fail('Assistant image output cannot be converted to Responses') : { type: 'input_image', image_url: p.url, detail: p.detail ?? 'auto' }) });
      for (const t of m.calls ?? []) input.push({ type: 'function_call', call_id: t.id, name: t.name, arguments: t.arguments });
    }
    let format = c.format;
    if (format?.type === 'json_schema') format = { type: 'json_schema', ...format.json_schema };
    return clean({ model, input, stream, ...c.openai, store: false, max_output_tokens: c.maxTokens, temperature: c.temperature, top_p: c.topP, tools: c.tools?.map(t => clean({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: t.strict })), tool_choice: typeof c.choice === 'object' ? { type: 'function', name: c.choice.name } : c.choice, parallel_tool_calls: c.parallel, text: format || c.verbosity != null ? clean({ format: format ? clean(format) : undefined, verbosity: c.verbosity }) : undefined, reasoning: c.effort != null || c.summary != null ? clean({ effort: c.effort, summary: c.summary }) : undefined });
  }
  if (to === 'anthropic') {
    const messages: Obj[] = []; const system: Part[] = [];
    for (const m of c.messages) {
      if (m.role === 'system' || m.role === 'developer') { if (system.length) system.push({ type: 'text', text: '\n\n' }); system.push(...m.content); continue; }
      const role = m.role === 'assistant' ? 'assistant' : 'user'; const content: Obj[] = [];
      if (m.role === 'tool') content.push({ type: 'tool_result', tool_use_id: m.callId, content: onlyText(m.content, 'tool result'), ...(m.isError ? { is_error: true } : {}) });
      else content.push(...m.content.map(toAnthropicPart));
      for (const t of m.calls ?? []) content.push({ type: 'tool_use', id: t.id, name: t.name, input: argsObject(t.arguments, 'tool arguments') });
      const last = messages.at(-1); if (last?.role === role) last.content.push(...content); else messages.push({ role, content });
    }
    let toolChoice: Obj | undefined = c.choice == null ? undefined : typeof c.choice === 'object' ? { type: 'tool', name: c.choice.name } : { type: c.choice === 'required' ? 'any' : c.choice };
    if (c.parallel != null) toolChoice = { ...(toolChoice ?? { type: 'auto' }), disable_parallel_tool_use: !c.parallel };
    return clean({ model, messages, system: system.length ? onlyText(system, 'system') : undefined, stream, max_tokens: c.maxTokens ?? 4096, temperature: c.temperature, top_p: c.topP, top_k: c.topK, stop_sequences: c.stop, tools: c.tools?.map(t => clean({ name: t.name, description: t.description, input_schema: t.parameters, strict: t.strict })), tool_choice: toolChoice });
  }
  const contents: Obj[] = []; const system: Part[] = [];
  for (const m of c.messages) {
    if (m.role === 'system' || m.role === 'developer') { if (system.length) system.push({ type: 'text', text: '\n\n' }); system.push(...m.content); continue; }
    const role = m.role === 'assistant' ? 'model' : 'user'; const parts: Obj[] = [];
    if (m.role === 'tool') {
      const name = m.name ?? names.get(m.callId!); if (!name) fail(`Cannot find function name for tool result ${m.callId}`);
      const text = onlyText(m.content, 'tool result'); let response: any;
      try { response = JSON.parse(text); } catch { response = text; }
      if (m.isError) response = { error: response };
      else if (!response || typeof response !== 'object' || Array.isArray(response)) response = { result: response };
      parts.push({ functionResponse: { id: m.callId, name, response } });
    } else parts.push(...m.content.map(toGeminiPart));
    for (const t of m.calls ?? []) parts.push({ functionCall: { id: t.id, name: t.name, args: argsObject(t.arguments, 'tool arguments') } });
    const last = contents.at(-1); if (last?.role === role) last.parts.push(...parts); else contents.push({ role, parts });
  }
  if (c.format?.type === 'json_schema' && (c.format.json_schema?.strict != null || c.format.json_schema?.description)) fail('Strict/description JSON output schema settings have no exact Gemini equivalent');
  const generationConfig = clean({ maxOutputTokens: c.maxTokens, temperature: c.temperature, topP: c.topP, topK: c.topK, stopSequences: c.stop, seed: c.seed, responseMimeType: c.format && c.format.type !== 'text' ? 'application/json' : undefined, responseJsonSchema: c.format?.type === 'json_schema' ? c.format.json_schema.schema : undefined });
  const calling = c.choice == null ? undefined : typeof c.choice === 'object' ? { mode: 'ANY', allowedFunctionNames: [c.choice.name] } : { mode: c.choice === 'required' ? 'ANY' : c.choice === 'none' ? 'NONE' : 'AUTO' };
  return clean({ contents, systemInstruction: system.length ? { parts: [{ text: onlyText(system, 'system') }] } : undefined, generationConfig: Object.keys(generationConfig).length ? generationConfig : undefined, tools: c.tools?.length ? [{ functionDeclarations: c.tools.map(t => clean({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }] : undefined, toolConfig: calling ? { functionCallingConfig: calling } : undefined });
}
function clean(obj: Obj): Obj { return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)); }

export function convertRequest(body: any, from: Protocol, to: Protocol, model: string, stream: boolean, warnings: string[] = []): any {
  if (from === to) return body;
  const input = object(body, 'request');
  const canonical = from === 'openai' ? readChat(input) : from === 'responses' ? readResponses(input) : from === 'anthropic' ? readAnthropic(input) : readGemini(input);
  return encodeRequest(canonical, to, model, stream, warnings);
}

function numeric(v: any): number { return typeof v === 'number' && Number.isFinite(v) ? v : 0; }
export function validateResponseReasoning(item: unknown): void {
  if (!item || typeof item !== 'object' || Array.isArray(item)) bad('Responses reasoning item must be an object');
  const reasoning = item as Obj;
  if (reasoning.type !== 'reasoning') bad('Expected a Responses reasoning item');
  if (reasoning.id != null && (typeof reasoning.id !== 'string' || !reasoning.id)) bad('Responses reasoning id must be a nonempty string');
  if (reasoning.encrypted_content != null && typeof reasoning.encrypted_content !== 'string') bad('Responses encrypted reasoning must be a string');
  if (reasoning.summary != null) {
    if (!Array.isArray(reasoning.summary)) bad('Responses reasoning summary must be an array');
    for (const part of reasoning.summary) if (!part || part.type !== 'summary_text' || typeof part.text !== 'string') bad('Invalid reasoning summary part');
  }
  if (reasoning.content != null) {
    if (!Array.isArray(reasoning.content)) bad('Responses reasoning content must be an array');
    for (const part of reasoning.content) if (!part || part.type !== 'reasoning_text' || typeof part.text !== 'string') bad('Invalid reasoning content part');
  }
}
function usage(body: Obj, from: Protocol): Usage | undefined {
  const u = from === 'gemini' ? body.usageMetadata : body.usage;
  if (!u) return undefined;
  let input = 0, output = 0, cached = 0, cacheWrite = 0, reasoning = 0, total: number | undefined;
  if (from === 'openai') { input = numeric(u.prompt_tokens); output = numeric(u.completion_tokens); cached = numeric(u.prompt_tokens_details?.cached_tokens); reasoning = numeric(u.completion_tokens_details?.reasoning_tokens); total = u.total_tokens; }
  else if (from === 'responses') { input = numeric(u.input_tokens); output = numeric(u.output_tokens); cached = numeric(u.input_tokens_details?.cached_tokens); reasoning = numeric(u.output_tokens_details?.reasoning_tokens); total = u.total_tokens; }
  else if (from === 'anthropic') { cached = numeric(u.cache_read_input_tokens); cacheWrite = numeric(u.cache_creation_input_tokens); input = numeric(u.input_tokens) + cached + cacheWrite; output = numeric(u.output_tokens); }
  else { input = numeric(u.promptTokenCount); reasoning = numeric(u.thoughtsTokenCount); output = numeric(u.candidatesTokenCount) + reasoning; cached = numeric(u.cachedContentTokenCount); total = u.totalTokenCount; }
  return { input, output, total: typeof total === 'number' ? total : input + output, cached, cacheWrite, reasoning };
}
function finish(value: any, from: Protocol, calls: boolean): string {
  if (from === 'openai') {
    if (!['stop', 'length', 'tool_calls', 'content_filter'].includes(value)) bad(`Unsupported or absent upstream finish_reason: ${String(value)}`);
    return value;
  }
  if (from === 'anthropic') {
    if (['end_turn', 'stop_sequence'].includes(value)) return calls ? 'tool_calls' : 'stop';
    if (value === 'tool_use') return 'tool_calls';
    if (value === 'max_tokens') return 'length';
    if (value === 'refusal') return 'content_filter';
    bad(`Unsupported or absent Anthropic stop_reason: ${String(value)}`);
  }
  if (from === 'gemini') {
    if (value === 'STOP') return calls ? 'tool_calls' : 'stop';
    if (value === 'MAX_TOKENS') return 'length';
    if (['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY'].includes(value)) return 'content_filter';
    bad(`Gemini did not complete successfully: ${String(value)}`);
  }
  return value;
}
function responseCanonical(body: Obj, from: Protocol): ChatResponse {
  if (body.error) bad(`Upstream returned an error: ${body.error.message ?? body.error.type ?? 'unknown error'}`);
  const c: ChatResponse = { id: String(body.id ?? body.responseId ?? crypto.randomUUID()), created: numeric(body.created ?? body.created_at) || Math.floor(Date.now() / 1000), content: [], calls: [], finish: 'stop', usage: usage(body, from) };
  if (from === 'openai') {
    const choices = array(body.choices, 'choices'); if (choices.length !== 1) fail('Cross-protocol conversion supports one completion only');
    const m = object(choices[0].message, 'message'); keys(m, ['role', 'content', 'tool_calls', 'refusal', 'annotations'], 'response.message');
    if (m.role != null && m.role !== 'assistant') bad('Upstream output role must be assistant');
    if (m.annotations?.length) fail('Cross-protocol annotated/cited text is not supported');
    if (choices[0].logprobs != null) fail('Cross-protocol token log probabilities are not supported');
    c.content = textParts(m.content, 'response.content'); if (m.tool_calls) c.calls = readCalls(m.tool_calls, 'tool_calls');
    if (m.refusal != null) c.refusal = string(m.refusal, 'refusal'); c.finish = finish(choices[0].finish_reason, from, !!c.calls.length);
  } else if (from === 'responses') {
    if (!['completed', 'incomplete'].includes(body.status)) bad(`Responses upstream status is ${String(body.status)}`);
    if (body.status === 'incomplete') {
      const reason = body.incomplete_details?.reason;
      if (!['max_output_tokens', 'content_filter'].includes(reason)) bad(`Unconvertible incomplete response: ${String(reason)}`);
      c.finish = reason === 'max_output_tokens' ? 'length' : 'content_filter';
    }
    for (const item of array(body.output, 'output')) {
      if (item.type === 'reasoning') {
        validateResponseReasoning(item);
      } else if (item.type === 'message') {
        if (item.role && item.role !== 'assistant') bad('Responses output message must have assistant role');
        for (const p of array(item.content, 'message.content')) {
          if (p.type === 'refusal') { c.refusal = (c.refusal ?? '') + string(p.refusal, 'refusal'); continue; }
          c.content.push(...textParts([p], 'output.content'));
        }
      } else if (item.type === 'function_call') c.calls.push({ id: nonempty(item.call_id, 'call_id'), name: nonempty(item.name, 'function name'), arguments: args(item.arguments ?? '{}', 'function arguments') });
      else fail(`Unsupported Responses output item ${item.type}`);
    }
    if (c.finish === 'stop' && c.calls.length) c.finish = 'tool_calls';
  } else if (from === 'anthropic') {
    for (const p of array(body.content, 'content')) {
      if (p.type === 'tool_use') { keys(p, ['type', 'id', 'name', 'input'], 'tool_use'); c.calls.push({ id: nonempty(p.id, 'tool id'), name: nonempty(p.name, 'function name'), arguments: args(p.input ?? {}, 'tool input') }); }
      else c.content.push(anthropicPart(p));
    }
    c.finish = finish(body.stop_reason, from, !!c.calls.length);
  } else {
    const candidates = array(body.candidates ?? [], 'candidates');
    if (!candidates.length && body.promptFeedback?.blockReason) { c.finish = 'content_filter'; return c; }
    if (candidates.length !== 1) fail('Cross-protocol conversion requires one Gemini candidate');
    if (candidates[0].citationMetadata?.citations?.length || candidates[0].groundingMetadata) fail('Gemini cited/grounded output requires same-protocol routing');
    for (const p of array(candidates[0].content?.parts ?? [], 'candidate.parts')) {
      if (p.functionCall) { keys(p, ['functionCall'], 'functionCall part'); const f = object(p.functionCall, 'functionCall'); keys(f, ['id', 'name', 'args'], 'functionCall'); c.calls.push({ id: f.id ?? `call_${c.calls.length}`, name: nonempty(f.name, 'function name'), arguments: args(f.args ?? {}, 'function args') }); }
      else c.content.push(geminiPart(p));
    }
    c.finish = finish(candidates[0].finishReason, from, !!c.calls.length);
  }
  return c;
}
function encodeResponse(c: ChatResponse, to: Protocol, model: string): Obj {
  const u = c.usage;
  if (to === 'openai') return clean({ id: c.id, object: 'chat.completion', created: c.created, model, choices: [{ index: 0, message: clean({ role: 'assistant', content: c.content.length ? chatContent(c.content) : c.calls.length || c.refusal ? null : '', refusal: c.refusal, tool_calls: c.calls.length ? c.calls.map(t => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.arguments } })) : undefined }), finish_reason: c.finish }], usage: u ? { prompt_tokens: u.input, completion_tokens: u.output, total_tokens: u.total, prompt_tokens_details: { cached_tokens: u.cached }, completion_tokens_details: { reasoning_tokens: u.reasoning } } : undefined });
  if (to === 'responses') {
    const incomplete = c.finish === 'length' || c.finish === 'content_filter'; const output: Obj[] = [];
    const content: Obj[] = c.content.length ? [{ type: 'output_text', text: onlyText(c.content, 'Responses output'), annotations: [] }] : [];
    if (c.refusal) content.push({ type: 'refusal', refusal: c.refusal });
    if (content.length || !c.calls.length) output.push({ id: `msg_${c.id}`, type: 'message', role: 'assistant', status: incomplete ? 'incomplete' : 'completed', content });
    for (const t of c.calls) output.push({ type: 'function_call', id: `fc_${t.id}`, call_id: t.id, name: t.name, arguments: t.arguments, status: incomplete ? 'incomplete' : 'completed' });
    return { id: c.id, object: 'response', created_at: c.created, model, status: incomplete ? 'incomplete' : 'completed', error: null, incomplete_details: incomplete ? { reason: c.finish === 'length' ? 'max_output_tokens' : 'content_filter' } : null, output, output_text: onlyText(c.content, 'Responses output'), usage: u ? { input_tokens: u.input, output_tokens: u.output, total_tokens: u.total, input_tokens_details: { cached_tokens: u.cached }, output_tokens_details: { reasoning_tokens: u.reasoning } } : null };
  }
  if (to === 'anthropic') {
    const content: Obj[] = c.content.map(toAnthropicPart); if (c.refusal) content.push({ type: 'text', text: c.refusal });
    for (const t of c.calls) content.push({ type: 'tool_use', id: t.id, name: t.name, input: argsObject(t.arguments, 'tool arguments') });
    if (!content.length) content.push({ type: 'text', text: '' });
    return clean({ id: c.id, type: 'message', role: 'assistant', model, content, stop_reason: c.finish === 'tool_calls' ? 'tool_use' : c.finish === 'length' ? 'max_tokens' : c.finish === 'content_filter' ? 'refusal' : 'end_turn', stop_sequence: null, usage: u ? { input_tokens: Math.max(0, u.input - u.cached - u.cacheWrite), output_tokens: u.output, cache_read_input_tokens: u.cached, cache_creation_input_tokens: u.cacheWrite } : undefined });
  }
  const parts: Obj[] = c.content.map(toGeminiPart); if (c.refusal) parts.push({ text: c.refusal });
  for (const t of c.calls) parts.push({ functionCall: { id: t.id, name: t.name, args: argsObject(t.arguments, 'tool arguments') } });
  return clean({ responseId: c.id, modelVersion: model, candidates: [{ index: 0, content: { role: 'model', parts }, finishReason: c.finish === 'length' ? 'MAX_TOKENS' : c.finish === 'content_filter' ? 'SAFETY' : 'STOP' }], usageMetadata: u ? { promptTokenCount: u.input, candidatesTokenCount: Math.max(0, u.output - u.reasoning), totalTokenCount: u.total, cachedContentTokenCount: u.cached, thoughtsTokenCount: u.reasoning } : undefined });
}
export function convertResponse(body: any, from: Protocol, to: Protocol, model: string): any {
  if (from === to) return body;
  try {
    return encodeResponse(responseCanonical(object(body, 'upstream response'), from), to, model);
  } catch (error) {
    if (error instanceof ProtocolConversionError) throw new ProtocolConversionError(error.message, 502);
    throw error;
  }
}
export { encodeResponse, responseCanonical, usage as responseUsage, finish as responseFinish };
export { convertStream } from './sse';
