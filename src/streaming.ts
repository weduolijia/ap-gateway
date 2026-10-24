import { createParser } from 'eventsource-parser';
import type { Protocol } from './types';

export interface StreamResult { outcome: 'ok' | 'error' | 'cancelled'; firstByteMs: number | null; error?: string; errorMessage?: string }
function upstreamMessage(data: any): string | undefined {
  const value = data?.error?.message ?? data?.response?.error?.message ?? data?.message ?? data?.error?.code;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
export function streamErrorFrame(protocol: Protocol, message: string, sequenceNumber = 0): Uint8Array {
  const error = { type: 'upstream_stream_error', code: 'upstream_stream_error', message };
  const data = protocol === 'anthropic' ? { type: 'error', error } : protocol === 'responses' ? { ...error, type: 'error', sequence_number: sequenceNumber } : { error };
  return new TextEncoder().encode(`event: error\ndata: ${JSON.stringify(data)}\n\n`);
}
export function monitorStream(source: ReadableStream<Uint8Array>, protocol: Protocol, options: {
  started: number; heartbeatMs: number; timeoutMs: number; abort: () => void; complete: (result: StreamResult) => void; sanitize?: (message: string) => string;
}): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  const decoder = new TextDecoder();
  const sanitize = options.sanitize ?? ((value: string) => value);
  let terminal = false;
  let finishReason = false;
  let streamFailure: string | undefined;
  let streamMessage: string | undefined;
  let errorSeen = false;
  let finished = false;
  let released = false;
  let firstByteMs: number | null = null;
  let sequenceNumber = 0;
  const geminiCandidates = new Set<number>();
  const finishedCandidates = new Set<number>();
  let lastData = Date.now();
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const parser = createParser({ onEvent(event) {
    if (event.data === '[DONE]') {
      if (protocol === 'openai') {
        terminal = true;
        if (!finishReason) streamFailure ??= 'upstream_stream_truncated';
      } else streamFailure ??= 'upstream_protocol_error';
      return;
    }
    let data: any;
    try { data = JSON.parse(event.data); } catch { streamFailure ??= 'upstream_invalid_json'; return; }
    if (!data || typeof data !== 'object' || Array.isArray(data)) { streamFailure ??= 'upstream_protocol_error'; return; }
    if (protocol === 'responses' && Number.isSafeInteger(data.sequence_number) && data.sequence_number >= sequenceNumber) sequenceNumber = data.sequence_number + 1;
    if (event.event === 'error' || data.error || data.type === 'error') {
      streamFailure = 'upstream_stream_error';
      streamMessage ??= upstreamMessage(data);
      terminal = true;
      errorSeen = true;
      return;
    }
    if (protocol === 'openai') {
      for (const choice of Array.isArray(data.choices) ? data.choices : []) if (choice.finish_reason) {
        finishReason = true;
        if (!['stop', 'tool_calls', 'function_call'].includes(choice.finish_reason)) streamFailure ??= 'upstream_generation_incomplete';
      }
    } else if (protocol === 'responses') {
      const type = data.type ?? event.event;
      if (['response.completed', 'response.incomplete', 'response.failed'].includes(type)) {
        terminal = true;
        if (type !== 'response.completed') {
          streamFailure ??= type === 'response.incomplete' ? 'upstream_generation_incomplete' : 'upstream_stream_error';
          if (type === 'response.failed') { streamMessage ??= upstreamMessage(data); errorSeen = true; }
        }
      }
    } else if (protocol === 'anthropic') {
      const type = data.type ?? event.event;
      if (type === 'message_delta' && data.delta?.stop_reason) {
        finishReason = true;
        if (!['end_turn', 'stop_sequence', 'tool_use'].includes(data.delta.stop_reason)) streamFailure ??= 'upstream_generation_incomplete';
      }
      if (type === 'message_stop') {
        terminal = true;
        if (!finishReason) streamFailure ??= 'upstream_stream_truncated';
      }
    } else {
      if (data.promptFeedback?.blockReason) { terminal = true; streamFailure ??= 'upstream_generation_incomplete'; }
      for (const candidate of Array.isArray(data.candidates) ? data.candidates : []) {
        const candidateIndex = candidate.index ?? 0;
        geminiCandidates.add(candidateIndex);
        if (candidate.finishReason) {
          finishedCandidates.add(candidateIndex);
          if (candidate.finishReason !== 'STOP') streamFailure ??= 'upstream_generation_incomplete';
        }
      }
      if (geminiCandidates.size) terminal = finishedCandidates.size === geminiCandidates.size;
    }
  }, maxBufferSize: 2 * 1024 * 1024 });
  const release = () => { if (!released) { released = true; reader.releaseLock(); } };
  const cleanup = async (reason?: any) => {
    try { await reader.cancel(reason); } catch {} finally { release(); }
  };
  const finish = (outcome: StreamResult['outcome'], error?: string) => {
    if (finished) return;
    finished = true;
    if (timer) clearTimeout(timer);
    options.complete({ outcome, firstByteMs, ...(error ? { error } : {}), ...(streamMessage ? { errorMessage: streamMessage } : {}) });
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) return;
      try {
        pending ??= reader.read();
        const remaining = options.timeoutMs - (Date.now() - lastData);
        if (remaining <= 0) throw new Error('上游流超过空闲超时，连接已关闭');
        const heartbeat = new Promise<'heartbeat'>(resolve => { timer = setTimeout(() => resolve('heartbeat'), Math.max(1, Math.min(options.heartbeatMs, remaining))); });
        const next = await Promise.race([pending, heartbeat]);
        if (timer) clearTimeout(timer);
        if (finished) return;
        if (next === 'heartbeat') {
          if (Date.now() - lastData >= options.timeoutMs) throw new Error('上游流超过空闲超时，连接已关闭');
          controller.enqueue(new TextEncoder().encode(': ap-heartbeat\n\n'));
          return;
        }
        pending = undefined;
        if (next.done) {
          parser.feed(decoder.decode());
          if (errorSeen) {
            controller.enqueue(streamErrorFrame(protocol, sanitize(streamMessage ?? '上游返回错误事件'), sequenceNumber));
            finish('error', 'upstream_stream_error');
          } else if (!terminal) {
            controller.enqueue(streamErrorFrame(protocol, '上游流在结束事件前断开，请勿将本次响应视为完整结果', sequenceNumber));
            finish('error', streamFailure ?? 'upstream_stream_truncated');
          } else finish(streamFailure ? 'error' : 'ok', streamFailure);
          release();
          controller.close();
          return;
        }
        if (firstByteMs === null) firstByteMs = Date.now() - options.started;
        lastData = Date.now();
        parser.feed(decoder.decode(next.value, { stream: true }));
        // Drop the raw chunk: upstream error text must not reach clients unfiltered.
        if (errorSeen) {
          controller.enqueue(streamErrorFrame(protocol, sanitize(streamMessage ?? '上游返回错误事件'), sequenceNumber));
          finish('error', 'upstream_stream_error');
          controller.close();
          void cleanup();
          return;
        }
        controller.enqueue(next.value);
        if (terminal && protocol !== 'gemini') {
          finish(streamFailure ? 'error' : 'ok', streamFailure);
          controller.close();
          void cleanup();
        }
      } catch (error) {
        if (finished) return;
        const conversion = error instanceof Error && 'code' in error && error.code === 'unsupported_protocol_conversion';
        const timeout = error instanceof Error && error.message.includes('超时');
        const message = timeout ? error.message : conversion ? error.message : '上游流读取失败或协议事件无效';
        const code = conversion ? 'unsupported_protocol_conversion' : timeout ? 'upstream_timeout' : 'upstream_stream_error';
        if (conversion && error instanceof Error) streamMessage ??= error.message;
        options.abort();
        void cleanup(error);
        controller.enqueue(streamErrorFrame(protocol, sanitize(message), sequenceNumber));
        controller.close();
        finish('error', code);
      }
    },
    async cancel(reason) {
      if (finished) return;
      options.abort();
      finish('cancelled', 'client_cancelled');
      await cleanup(reason);
    },
  }, { highWaterMark: 0 });
}
