# Third-party notices

The Responses and Gemini field mappings in `src/protocols.ts` were adapted and substantially rewritten from [leeguooooo/cloudflare-llm-gateway](https://github.com/leeguooooo/cloudflare-llm-gateway), commit `4e52f3a1e0c45f743a58474c77060799ad7e685d`, specifically `src/responses.ts` and `src/gemini-compat.ts`.

Copyright (c) 2026 cloudflare-llm-gateway contributors. Licensed under the MIT License. The complete upstream license is preserved at `vendor/cloudflare-llm-gateway/LICENSE`.

This gateway replaces silent dropping of unsupported content, incomplete tool-result correlation, malformed JSON substitution, and optimistic end-of-stream handling with explicit conversion errors and incremental stream validation. It is not an upstream fork and does not imply endorsement by upstream contributors.

Runtime dependency `eventsource-parser` is MIT licensed (Espen Hovlandsdal and contributors); its package includes the license. `hono` is MIT licensed (Yusuke Wada and contributors); its package includes the license. Lockfile versions define the actual dependencies used by this project.

Protocol references used during implementation (accessed 2026-10-23):

- OpenAI Responses and streaming: https://developers.openai.com/api/reference/resources/responses/streaming-events
- OpenAI function calling: https://developers.openai.com/api/docs/guides/function-calling
- Anthropic Messages streaming: https://platform.claude.com/docs/en/build-with-claude/streaming
- Gemini generateContent: https://ai.google.dev/api/generate-content
- Gemini function calling: https://ai.google.dev/gemini-api/docs/generate-content/function-calling

Cross-protocol support covers text, HTTP(S)/base64 image inputs, custom function tools, tool results, generation limits, common sampling controls, compatible structured outputs, finish reasons, and token usage. Provider-specific state references, built-in/server tools, audio/video/documents, reasoning or signature blocks, provider file IDs, and unsupported parameters require a matching upstream protocol. Same-protocol requests/responses/streams bypass conversion and preserve their payloads.

Responses output reasoning items and their text/summary lifecycle events are accepted as auxiliary output during cross-protocol conversion; answer text, function calls, terminal status and reasoning-token usage remain intact. Reasoning text, summaries and encrypted reasoning state are omitted from the target answer rather than emitted as ordinary assistant content. Native Responses passthrough preserves the original items and events, and request-side reasoning state still requires native routing.

The request compatibility layer additionally normalizes neutral SDK defaults and maps shared Chat/Responses bookkeeping, generation and tool fields. Optional bookkeeping without a destination equivalent produces field-only conversion warnings. Meaningful state, retention or generation semantics that cannot be represented still fail explicitly; a fixed channel protocol is never replaced by the client protocol as a fallback.
