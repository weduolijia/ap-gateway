import { convertResponse, convertStream } from './protocols';
import type { Protocol } from './types';

function promptText(value: any): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(promptText).filter(Boolean).join('\n');
  if (value && typeof value === 'object') return promptText(value.text ?? value.content ?? value.parts);
  return '';
}
export function demoResponse(protocol: Protocol, body: any, model: string, stream: boolean, environment = 'local'): Response {
  const prompt = body.messages?.at(-1)?.content ?? body.input ?? body.contents?.at(-1)?.parts?.[0]?.text ?? '';
  const location = environment === 'local' ? '本地' : '云端';
  const text = `AP Gateway ${location}演示已连接。\n\n你发送了：${promptText(prompt).slice(0, 300)}\n\n这段内容由${location}演示器逐块输出，用于验证协议、首字节延迟、停止生成和请求日志，不调用真实大模型。添加你的上游网关后即可开始真实模型测试。`;
  const id = `chatcmpl-demo-${crypto.randomUUID()}`;
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  if (!stream) return Response.json(convertResponse({ id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage }, 'openai', protocol, model));
  const parts = text.match(/.{1,6}|\n/gu) ?? [];
  const enc = new TextEncoder();
  let step = -1;
  let cancelled = false;
  const source = new ReadableStream<Uint8Array>({
    async pull(c) {
      await new Promise(resolve => setTimeout(resolve, 24));
      if (cancelled) return;
      if (step === -1) { step++; c.enqueue(enc.encode(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`)); }
      else if (step < parts.length) c.enqueue(enc.encode(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content: parts[step++] }, finish_reason: null }] })}\n\n`));
      else { c.enqueue(enc.encode(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage })}\n\ndata: [DONE]\n\n`)); c.close(); }
    },
    cancel() { cancelled = true; },
  });
  return new Response(convertStream(source, 'openai', protocol, model), { headers: { 'content-type': 'text/event-stream' } });
}
