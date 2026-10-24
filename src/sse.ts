import { createParser, type EventSourceMessage } from 'eventsource-parser';
import { encodeResponse, responseCanonical, responseUsage, responseFinish, validateResponseReasoning, ProtocolConversionError, type Call, type ChatResponse } from './protocols';
import type { Protocol } from './types';

type Obj = Record<string, any>;
type OutputBlock = { kind: 'text' | 'refusal' | 'call'; index: number; callIndex?: number; itemId?: string; text?: string; emitted?: boolean };
const encoder = new TextEncoder();
const maximumResponseSize = 16 * 1024 * 1024;

function invalid(message: string): never { throw new ProtocolConversionError(message, 502); }
function upstreamErrorMessage(body: Obj): string | undefined {
  const value = body.error && typeof body.error === 'object' ? (body.error as Obj).message ?? (body.error as Obj).code : body.error ?? body.response?.error?.message ?? body.message;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function record(value: any, label: string): Obj {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be an object`);
  return value;
}
function text(value: any, label: string): string {
  if (typeof value !== 'string') invalid(`${label} must be a string`);
  return value;
}
function list(value: any, label: string): any[] {
  if (!Array.isArray(value)) invalid(`${label} must be an array`);
  return value;
}
function index(value: any, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) invalid(`${label} must be a nonnegative integer`);
  return value;
}
function supported(value: Obj, allowed: string[], label: string) {
  for (const key of Object.keys(value)) if (value[key] != null && !allowed.includes(key)) invalid(`Cross-protocol streaming does not support ${label}.${key}; use same-protocol routing`);
}

class StreamWriter {
  started = false;
  private sequence = 0;
  private blocks: OutputBlock[] = [];
  private currentText: OutputBlock | undefined;
  private geminiCallStarted = false;
  constructor(readonly protocol: Protocol, readonly model: string, readonly state: ChatResponse, readonly queue: Uint8Array[]) {}
  event(data: Obj, event?: string) {
    if (this.protocol === 'responses') data = { ...data, sequence_number: this.sequence++ };
    this.queue.push(encoder.encode(`${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`));
  }
  reasoningActivity() {
    this.queue.push(encoder.encode(': ap-reasoning\n\n'));
  }
  private responseEvent(type: string, data: Obj) { this.event({ type, ...data }, type); }
  private chat(delta: Obj, finishReason: string | null = null, usage?: Obj) {
    this.event({ id: this.state.id, object: 'chat.completion.chunk', created: this.state.created, model: this.model, choices: [{ index: 0, delta, finish_reason: finishReason }], ...(usage ? { usage } : {}) });
  }
  start() {
    if (this.started) return;
    this.started = true;
    if (this.protocol === 'openai') this.chat({ role: 'assistant', content: '' });
    else if (this.protocol === 'responses') {
      const response = { id: this.state.id, object: 'response', created_at: this.state.created, model: this.model, status: 'in_progress', error: null, incomplete_details: null, output: [], usage: null };
      this.responseEvent('response.created', { response });
      this.responseEvent('response.in_progress', { response });
    } else if (this.protocol === 'anthropic') {
      const usage = encodeResponse(this.state, 'anthropic', this.model).usage ?? { input_tokens: 0, output_tokens: 0 };
      this.event({ type: 'message_start', message: { id: this.state.id, type: 'message', role: 'assistant', model: this.model, content: [], stop_reason: null, stop_sequence: null, usage } }, 'message_start');
    }
  }
  private block(kind: OutputBlock['kind'], callIndex?: number, fresh = false): OutputBlock {
    if (!fresh) {
      const existing = this.blocks.find(block => block.kind === kind && block.callIndex === callIndex);
      if (existing) return existing;
    }
    const block: OutputBlock = { kind, index: this.blocks.length, ...(callIndex != null ? { callIndex } : {}), ...(kind !== 'call' ? { text: '' } : {}) };
    this.blocks.push(block);
    if (this.protocol === 'anthropic') {
      const call = callIndex == null ? undefined : this.state.calls[callIndex];
      const content = call ? { type: 'tool_use', id: call.id, name: call.name, input: {} } : { type: 'text', text: '' };
      this.event({ type: 'content_block_start', index: block.index, content_block: content }, 'content_block_start');
    } else if (this.protocol === 'responses') {
      const call = callIndex == null ? undefined : this.state.calls[callIndex];
      block.itemId = call ? `fc_${call.id}` : `msg_${this.state.id}_${block.index}`;
      const item = call
        ? { type: 'function_call', id: block.itemId, call_id: call.id, name: call.name, arguments: '', status: 'in_progress' }
        : { id: block.itemId, type: 'message', role: 'assistant', content: [], status: 'in_progress' };
      this.responseEvent('response.output_item.added', { output_index: block.index, item });
      if (!call) {
        const part = kind === 'refusal' ? { type: 'refusal', refusal: '' } : { type: 'output_text', text: '', annotations: [] };
        this.responseEvent('response.content_part.added', { item_id: block.itemId, output_index: block.index, content_index: 0, part });
      }
    }
    return block;
  }
  breakTextBlock() { this.currentText = undefined; }
  delta(value: string, kind: 'text' | 'refusal') {
    if (!value) return;
    this.start();
    const block = this.currentText && this.currentText.kind === kind ? this.currentText : this.block(kind, undefined, true);
    this.currentText = block;
    block.text = (block.text ?? '') + value;
    if (this.protocol === 'openai') this.chat({ [kind === 'text' ? 'content' : 'refusal']: value });
    else if (this.protocol === 'gemini') {
      // Text after a tool call is buffered and emitted with the final chunk so block order survives.
      if (!this.geminiCallStarted) { block.emitted = true; this.event({ responseId: this.state.id, modelVersion: this.model, candidates: [{ index: 0, content: { role: 'model', parts: [{ text: value }] } }] }); }
    }
    else if (this.protocol === 'anthropic') {
      this.event({ type: 'content_block_delta', index: block.index, delta: { type: 'text_delta', text: value } }, 'content_block_delta');
    } else {
      this.responseEvent(kind === 'text' ? 'response.output_text.delta' : 'response.refusal.delta', { item_id: block.itemId, output_index: block.index, content_index: 0, delta: value });
    }
  }
  call(callIndex: number, value: string, first: boolean) {
    this.start();
    this.currentText = undefined;
    const call = this.state.calls[callIndex];
    if (this.protocol === 'openai') this.chat({ tool_calls: [{ index: callIndex, ...(first ? { id: call.id, type: 'function' } : {}), function: { ...(first ? { name: call.name } : {}), arguments: value } }] });
    else if (this.protocol === 'anthropic') {
      const block = this.block('call', callIndex);
      if (value) this.event({ type: 'content_block_delta', index: block.index, delta: { type: 'input_json_delta', partial_json: value } }, 'content_block_delta');
    } else if (this.protocol === 'responses') {
      const block = this.block('call', callIndex);
      if (value) this.responseEvent('response.function_call_arguments.delta', { item_id: block.itemId, output_index: block.index, delta: value });
    } else {
      this.block('call', callIndex);
      this.geminiCallStarted = true;
    }
  }
  finish() {
    const completed = encodeResponse(this.state, this.protocol, this.model);
    this.start();
    if (this.protocol === 'openai') {
      this.chat({}, this.state.finish);
      if (completed.usage) this.event({ id: this.state.id, object: 'chat.completion.chunk', created: this.state.created, model: this.model, choices: [], usage: completed.usage });
      this.queue.push(encoder.encode('data: [DONE]\n\n'));
    } else if (this.protocol === 'anthropic') {
      for (const block of this.blocks) this.event({ type: 'content_block_stop', index: block.index }, 'content_block_stop');
      this.event({ type: 'message_delta', delta: { stop_reason: completed.stop_reason, stop_sequence: null }, usage: completed.usage ?? { output_tokens: 0 } }, 'message_delta');
      this.event({ type: 'message_stop' }, 'message_stop');
    } else if (this.protocol === 'gemini') {
      const calls = new Map(completed.candidates[0].content.parts.filter((part: Obj) => part.functionCall).map((part: Obj) => [part.functionCall.id, part]));
      const parts: Obj[] = [];
      for (const block of this.blocks) {
        if (block.kind === 'call') {
          const part = calls.get(this.state.calls[block.callIndex!].id);
          if (part) parts.push(part);
        } else if (!block.emitted && block.text) parts.push({ text: block.text });
      }
      completed.candidates[0].content.parts = parts;
      this.event(completed);
    } else {
      if (!this.blocks.length) this.block('text');
      const status = completed.status ?? 'completed';
      const output = this.blocks.map(block => {
        if (block.kind === 'call') {
          const call = this.state.calls[block.callIndex!];
          return completed.output.find((item: Obj) => item.call_id === call.id) ?? { id: block.itemId, type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments, status };
        }
        const part = block.kind === 'refusal' ? { type: 'refusal', refusal: block.text ?? '' } : { type: 'output_text', text: block.text ?? '', annotations: [] };
        return { id: block.itemId, type: 'message', role: 'assistant', status, content: block.text ? [part] : [] };
      });
      for (const block of this.blocks) {
        const item = output[block.index];
        if (block.kind === 'call') this.responseEvent('response.function_call_arguments.done', { item_id: item.id, output_index: block.index, name: item.name, arguments: item.arguments });
        else if (item.content.length) {
          const part = item.content[0];
          if (part.type === 'refusal') this.responseEvent('response.refusal.done', { item_id: item.id, output_index: block.index, content_index: 0, refusal: part.refusal });
          else this.responseEvent('response.output_text.done', { item_id: item.id, output_index: block.index, content_index: 0, text: part.text });
          this.responseEvent('response.content_part.done', { item_id: item.id, output_index: block.index, content_index: 0, part });
        }
        this.responseEvent('response.output_item.done', { output_index: block.index, item });
      }
      const text = this.blocks.filter(block => block.kind === 'text').map(block => block.text ?? '').join('');
      this.responseEvent(status === 'incomplete' ? 'response.incomplete' : 'response.completed', { response: { ...completed, output, output_text: text } });
    }
  }
}

class StreamReader {
  terminal = false;
  readonly state: ChatResponse = { id: `ap_${crypto.randomUUID()}`, created: Math.floor(Date.now() / 1000), content: [], calls: [], finish: '' };
  readonly writer: StreamWriter;
  private calls = new Map<number, number>();
  private legacyCallId: string | undefined;
  private geminiCallIds = new Map<string, number>();
  private sourceBlocks = new Map<number, 'text' | 'call'>();
  private sourceText = new Map<string, string>();
  private closedBlocks = new Set<number>();
  private sourceUsage: Obj = {};
  private size = 0;
  constructor(readonly from: Protocol, to: Protocol, model: string, queue: Uint8Array[]) { this.writer = new StreamWriter(to, model, this.state, queue); }
  private account(value: string) {
    this.size += value.length;
    if (this.size > maximumResponseSize) invalid('Cross-protocol response exceeds the 16 MiB conversion limit');
  }
  private metadata(body: Obj) {
    if (!this.writer.started) {
      if (body.id || body.responseId) this.state.id = String(body.id ?? body.responseId);
      if (typeof (body.created ?? body.created_at) === 'number') this.state.created = body.created ?? body.created_at;
    }
    const usage = this.from === 'gemini' ? body.usageMetadata : body.usage;
    if (usage) {
      this.sourceUsage = { ...this.sourceUsage, ...record(usage, 'usage') };
      this.state.usage = responseUsage(this.from === 'gemini' ? { usageMetadata: this.sourceUsage } : { usage: this.sourceUsage }, this.from);
    }
  }
  private delta(value: any, kind: 'text' | 'refusal' = 'text', key: string = kind) {
    const delta = text(value, 'content delta');
    this.account(delta);
    this.sourceText.set(key, (this.sourceText.get(key) ?? '') + delta);
    if (kind === 'refusal') this.state.refusal = (this.state.refusal ?? '') + delta;
    else {
      const part = this.state.content[0];
      if (part?.type === 'text') part.text += delta;
      else this.state.content.push({ type: 'text', text: delta });
    }
    this.writer.delta(delta, kind);
  }
  private fullText(value: any, kind: 'text' | 'refusal', key: string) {
    const full = text(value, 'completed content');
    const previous = this.sourceText.get(key) ?? '';
    if (!full.startsWith(previous)) invalid('Completed content differs from streamed deltas');
    this.delta(full.slice(previous.length), kind, key);
  }
  private call(sourceIndex: number, id: any, name: any, argumentsDelta = '') {
    let callIndex = this.calls.get(sourceIndex);
    const first = callIndex == null;
    if (first) {
      if (!text(id, 'tool call id') || !text(name, 'tool name')) invalid('Tool call requires a nonempty id and name before arguments');
      callIndex = this.state.calls.length;
      this.calls.set(sourceIndex, callIndex);
      this.state.calls.push({ id, name, arguments: '' });
    }
    const call = this.state.calls[callIndex!];
    if ((id != null && id !== call.id) || (name != null && name !== call.name)) invalid('Tool identity changed during streaming');
    const delta = text(argumentsDelta, 'tool argument delta');
    this.account(delta);
    call.arguments += delta;
    this.writer.call(callIndex!, delta, first);
  }
  private fullCall(sourceIndex: number, call: Call) {
    const callIndex = this.calls.get(sourceIndex);
    const previous = callIndex == null ? '' : this.state.calls[callIndex].arguments;
    if (!call.arguments.startsWith(previous)) invalid('Completed tool arguments differ from streamed deltas');
    this.call(sourceIndex, call.id, call.name, call.arguments.slice(previous.length));
  }
  private finish(value?: string) {
    if (value) this.state.finish = value;
    if (!this.state.finish) invalid('Upstream stream ended without a finish reason');
    if (this.state.finish === 'stop' && this.state.calls.length) this.state.finish = 'tool_calls';
    for (const [callIndex, call] of this.state.calls.entries()) {
      if (!call.arguments) { call.arguments = '{}'; this.writer.call(callIndex, '{}', false); }
    }
    this.writer.finish();
    this.terminal = true;
  }
  end() {
    if (this.from === 'gemini' && this.state.finish) this.finish();
    if (!this.terminal) invalid('Upstream stream ended before its terminal event');
  }
  event(event: EventSourceMessage) {
    if (this.terminal) return;
    if (event.data === '[DONE]') {
      if (this.from !== 'openai') invalid('Unexpected [DONE] for upstream protocol');
      this.finish();
      return;
    }
    let body: Obj;
    try { body = record(JSON.parse(event.data), 'upstream event'); } catch (error) {
      if (error instanceof ProtocolConversionError) throw error;
      invalid('Upstream SSE contains invalid JSON');
    }
    if (event.event === 'error' || body.error || ['error', 'response.failed'].includes(body.type)) {
      const reason = upstreamErrorMessage(body);
      invalid(reason ? `Upstream returned an error event：${reason}` : 'Upstream returned an error event');
    }
    if (this.from === 'openai') this.chat(body);
    else if (this.from === 'responses') this.responses(body, event.event);
    else if (this.from === 'anthropic') this.anthropic(body, event.event);
    else this.gemini(body);
  }
  private chat(body: Obj) {
    this.metadata(body);
    if (body.choices == null) {
      if (!body.usage) invalid('Upstream chunk has neither choices nor usage');
      return;
    }
    const choices = list(body.choices, 'choices');
    if (choices.length > 1) invalid('Cross-protocol streaming supports one choice');
    if (!choices.length) return;
    const choice = record(choices[0], 'choice');
    if (choice.index != null && choice.index !== 0) invalid('Cross-protocol streaming supports choice index 0');
    if (choice.logprobs != null) invalid('Cross-protocol token log probabilities are not supported');
    const delta = record(choice.delta ?? {}, 'choice.delta');
    supported(delta, ['role', 'content', 'refusal', 'tool_calls', 'function_call'], 'chat delta');
    if (delta.role != null && delta.role !== 'assistant') invalid('Upstream output role must be assistant');
    this.writer.start();
    if (delta.content != null) this.delta(delta.content);
    if (delta.refusal != null) this.delta(delta.refusal, 'refusal');
    if (delta.function_call != null) {
      if (this.state.calls.length && !this.calls.has(-1)) invalid('A stream cannot mix tool_calls and legacy function_call');
      const f = record(delta.function_call, 'function_call'); supported(f, ['name', 'arguments'], 'function_call');
      const first = !this.calls.has(-1);
      if (first) {
        if (typeof f.name !== 'string' || !f.name) invalid('Legacy function_call requires a name before arguments');
        this.legacyCallId = `call_${crypto.randomUUID()}`;
      }
      this.call(-1, first ? this.legacyCallId : undefined, f.name, f.arguments ?? '');
    }
    if (delta.tool_calls) {
      if (this.calls.has(-1)) invalid('A stream cannot mix tool_calls and legacy function_call');
      for (const tool of list(delta.tool_calls, 'tool_calls')) {
        supported(record(tool, 'tool call'), ['index', 'id', 'type', 'function'], 'tool call');
        if (tool.type != null && tool.type !== 'function') invalid('Only function tools can be converted');
        const callable = record(tool.function ?? {}, 'tool function');
        supported(callable, ['name', 'arguments'], 'tool function');
        this.call(index(tool.index, 'tool index'), tool.id, callable.name, callable.arguments ?? '');
      }
    }
    if (choice.finish_reason != null) this.state.finish = responseFinish(choice.finish_reason, 'openai', !!this.state.calls.length);
  }
  private responses(body: Obj, eventName?: string) {
    const type = body.type ?? eventName;
    if (['response.created', 'response.in_progress', 'response.queued'].includes(type)) {
      this.metadata(record(body.response, 'response'));
      this.writer.start();
    } else if (type === 'response.output_item.added') {
      const item = record(body.item, 'output item');
      const outputIndex = index(body.output_index, 'output_index');
      if (item.type === 'reasoning') { validateResponseReasoning(item); this.writer.reasoningActivity(); }
      else if (item.type === 'function_call') this.call(outputIndex, item.call_id, item.name, item.arguments ?? '');
      else if (item.type === 'message') this.writer.breakTextBlock();
      else invalid(`Unsupported Responses streaming item ${item.type}; use same-protocol routing`);
    } else if (type === 'response.reasoning_summary_part.added' || type === 'response.reasoning_summary_part.done') {
      index(body.output_index, 'output_index');
      index(body.summary_index, 'summary_index');
      const part = record(body.part, 'reasoning summary part');
      if (part.type !== 'summary_text') invalid('Unsupported reasoning summary part');
      text(part.text, 'reasoning summary text');
      this.writer.reasoningActivity();
    } else if (['response.reasoning_summary_text.delta', 'response.reasoning_summary_text.done', 'response.reasoning_text.delta', 'response.reasoning_text.done'].includes(type)) {
      index(body.output_index, 'output_index');
      index(type.startsWith('response.reasoning_summary_') ? body.summary_index : body.content_index, 'reasoning text index');
      text(type.endsWith('.delta') ? body.delta : body.text, 'reasoning text');
      this.writer.reasoningActivity();
    } else if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
      if (body.logprobs?.length) invalid('Cross-protocol token log probabilities are not supported');
      const kind = type === 'response.refusal.delta' ? 'refusal' : 'text';
      this.delta(body.delta, kind, `${body.output_index}:${body.content_index}:${kind}`);
    } else if (type === 'response.output_text.done' || type === 'response.refusal.done') {
      if (body.logprobs?.length) invalid('Cross-protocol token log probabilities are not supported');
      const kind = type === 'response.refusal.done' ? 'refusal' : 'text';
      this.fullText(kind === 'refusal' ? body.refusal : body.text, kind, `${body.output_index}:${body.content_index}:${kind}`);
    } else if (type === 'response.function_call_arguments.delta') {
      this.call(index(body.output_index, 'output_index'), undefined, undefined, body.delta);
    } else if (type === 'response.function_call_arguments.done') {
      const sourceIndex = index(body.output_index, 'output_index');
      const callIndex = this.calls.get(sourceIndex);
      if (callIndex == null) invalid('Tool arguments arrived without output_item.added');
      this.fullCall(sourceIndex, { ...this.state.calls[callIndex], arguments: text(body.arguments, 'arguments') });
    } else if (type === 'response.output_item.done') {
      this.responsesItem(record(body.item, 'output item'), index(body.output_index, 'output_index'));
    } else if (type === 'response.content_part.added' || type === 'response.content_part.done') {
      const part = record(body.part, 'content part');
      if (!['output_text', 'refusal'].includes(part.type) || part.annotations?.length || part.logprobs?.length) invalid('Unsupported Responses content, annotations or token log probabilities');
    } else if (type === 'response.completed' || type === 'response.incomplete') {
      const response = record(body.response, 'response');
      const canonical = responseCanonical(response, 'responses');
      for (const [outputIndex, item] of list(response.output, 'output').entries()) this.responsesItem(item, outputIndex);
      this.metadata(response);
      this.finish(canonical.finish);
    } else invalid(`Unsupported Responses event ${String(type)}; use same-protocol routing`);
  }
  private responsesItem(item: Obj, outputIndex: number) {
    if (item.type === 'reasoning') { validateResponseReasoning(item); this.writer.reasoningActivity(); }
    else if (item.type === 'function_call') this.fullCall(outputIndex, { id: item.call_id, name: item.name, arguments: text(item.arguments ?? '', 'arguments') });
    else if (item.type === 'message') {
      if (item.role && item.role !== 'assistant') invalid('Responses output role must be assistant');
      for (const [contentIndex, part] of list(item.content, 'message.content').entries()) {
        if (part.type !== 'output_text' && part.type !== 'refusal') invalid(`Unsupported Responses output content ${part.type}`);
        if (part.annotations?.length) invalid('Cross-protocol annotated content is not supported');
        if (part.logprobs?.length) invalid('Cross-protocol token log probabilities are not supported');
        const kind = part.type === 'refusal' ? 'refusal' : 'text';
        this.fullText(kind === 'refusal' ? part.refusal : part.text, kind, `${outputIndex}:${contentIndex}:${kind}`);
      }
    } else invalid(`Unsupported Responses output item ${item.type}`);
  }
  private anthropic(body: Obj, eventName?: string) {
    const type = body.type ?? eventName;
    if (type === 'ping') return;
    if (type === 'message_start') {
      this.metadata(record(body.message, 'message'));
      if (body.message.content?.length) invalid('Anthropic message_start must have empty content');
      this.writer.start();
    } else if (type === 'content_block_start') {
      const blockIndex = index(body.index, 'content block index');
      if (this.sourceBlocks.has(blockIndex)) invalid('Duplicate Anthropic content block');
      const block = record(body.content_block, 'content block');
      if (block.type === 'text') {
        supported(block, ['type', 'text', 'citations'], 'Anthropic text');
        if (block.citations?.length) invalid('Cross-protocol citations are not supported');
        this.writer.breakTextBlock();
        this.sourceBlocks.set(blockIndex, 'text');
        if (block.text) this.delta(block.text);
      } else if (block.type === 'tool_use') {
        supported(block, ['type', 'id', 'name', 'input'], 'Anthropic tool');
        this.sourceBlocks.set(blockIndex, 'call');
        const input = record(block.input ?? {}, 'tool input');
        this.call(blockIndex, block.id, block.name, Object.keys(input).length ? JSON.stringify(input) : '');
      } else invalid(`Unsupported Anthropic streaming block ${block.type}; use same-protocol routing`);
    } else if (type === 'content_block_delta') {
      const blockIndex = index(body.index, 'content block index');
      if (this.closedBlocks.has(blockIndex)) invalid('Delta after content_block_stop');
      const delta = record(body.delta, 'content block delta');
      const block = this.sourceBlocks.get(blockIndex);
      if (delta.type === 'text_delta' && block === 'text') this.delta(delta.text);
      else if (delta.type === 'input_json_delta' && block === 'call') this.call(blockIndex, undefined, undefined, delta.partial_json);
      else invalid(`Unsupported or out-of-order Anthropic delta ${delta.type}`);
    } else if (type === 'content_block_stop') {
      const blockIndex = index(body.index, 'content block index');
      if (!this.sourceBlocks.has(blockIndex) || this.closedBlocks.has(blockIndex)) invalid('Unexpected content_block_stop');
      this.closedBlocks.add(blockIndex);
    } else if (type === 'message_delta') {
      this.metadata(body);
      const delta = record(body.delta, 'message delta');
      supported(delta, ['stop_reason', 'stop_sequence'], 'Anthropic message delta');
      if (delta.stop_reason) this.state.finish = responseFinish(delta.stop_reason, 'anthropic', !!this.state.calls.length);
    } else if (type === 'message_stop') {
      if (this.closedBlocks.size !== this.sourceBlocks.size) invalid('Anthropic stream ended with unclosed content blocks');
      this.finish();
    } else invalid(`Unsupported Anthropic stream event ${String(type)}`);
  }
  private gemini(body: Obj) {
    this.metadata(body);
    const candidates = list(body.candidates ?? [], 'candidates');
    if (!candidates.length) {
      if (body.promptFeedback?.blockReason) this.state.finish = 'content_filter';
      return;
    }
    if (candidates.length !== 1 || (candidates[0].index != null && candidates[0].index !== 0)) invalid('Cross-protocol streaming supports one Gemini candidate');
    const candidate = record(candidates[0], 'candidate');
    if (candidate.citationMetadata?.citations?.length || candidate.groundingMetadata) invalid('Gemini cited/grounded output requires same-protocol routing');
    if (this.state.finish && candidate.content?.parts?.length) invalid('Gemini sent content after its finishReason');
    for (const part of list(candidate.content?.parts ?? [], 'candidate parts')) {
      supported(record(part, 'Gemini part'), ['text', 'functionCall', 'thought', 'thoughtSignature', 'partMetadata', 'mediaResolution', 'mediaProcessing'], 'Gemini part');
      if (part.thought === true) continue;
      if (part.text != null) this.delta(part.text);
      else if (part.functionCall) {
        const call = record(part.functionCall, 'functionCall');
        supported(call, ['id', 'name', 'args', 'thoughtSignature'], 'Gemini functionCall');
        const id = typeof call.id === 'string' && call.id ? call.id : `call_${this.calls.size}`;
        const argumentsText = JSON.stringify(record(call.args ?? {}, 'function args'));
        const sourceIndex = this.geminiCallIds.get(id);
        if (sourceIndex == null) {
          this.geminiCallIds.set(id, this.calls.size);
          this.call(this.calls.size, id, call.name, argumentsText);
        } else {
          const existing = this.state.calls[this.calls.get(sourceIndex)!];
          if (existing.name !== call.name) invalid('Tool identity changed during streaming');
          // Gemini functionCall args are complete objects; a repeated id must be an exact duplicate.
          if (argumentsText !== existing.arguments) invalid('Tool arguments changed during streaming');
        }
      } else if (part.text == null && part.inlineData == null && part.fileData == null) continue;
      else invalid('Unsupported Gemini streaming part');
    }
    if (candidate.finishReason) this.state.finish = responseFinish(candidate.finishReason, 'gemini', !!this.state.calls.length);
  }
}

export function convertStream(source: ReadableStream<Uint8Array>, from: Protocol, to: Protocol, model: string): ReadableStream<Uint8Array> {
  if (from === to) return source;
  const reader = source.getReader();
  const queue: Uint8Array[] = [];
  const converter = new StreamReader(from, to, model, queue);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const parser = createParser({ onEvent: event => converter.event(event), maxBufferSize: 2 * 1024 * 1024 });
  let ended = false;
  let released = false;
  const release = () => { if (!released) { released = true; reader.releaseLock(); } };
  const cancel = async (reason?: any) => { try { await reader.cancel(reason); } catch {} finally { release(); } };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (!queue.length && !ended) {
          const next = await reader.read();
          if (ended) return;
          if (next.done) {
            parser.feed(decoder.decode());
            converter.end();
            ended = true;
            release();
          } else {
            parser.feed(decoder.decode(next.value, { stream: true }));
            if (converter.terminal) { ended = true; void cancel(); }
          }
        }
        if (queue.length) controller.enqueue(queue.shift()!);
        if (ended && !queue.length) controller.close();
      } catch (error) {
        if (ended) return;
        ended = true;
        void cancel(error);
        controller.error(error instanceof ProtocolConversionError ? error : new ProtocolConversionError('Upstream stream read or SSE parsing failed', 502));
      }
    },
    async cancel(reason) { ended = true; queue.length = 0; await cancel(reason); },
  }, { highWaterMark: 0 });
}
