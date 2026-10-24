# AP Gateway

> **AI-generated, for entertainment only.** This project and its documentation were produced by AI assistants and are published for fun and learning, not as production-ready software. 本项目由 AI 生成，仅供娱乐，请勿用于生产环境。

A Cloudflare Workers + D1 model gateway with a Chinese administration dashboard, channel management, model aliases, streaming tests and request logs.

Supports OpenAI Chat Completions, OpenAI Responses, Anthropic Messages and Gemini. A channel can use automatic protocol negotiation or a fixed upstream protocol. Native requests pass through without conversion; cross-protocol requests convert supported text, images and custom function tools, and reject unsupported semantics explicitly. Converted responses keep text and tool calls in their original order. Gemini thinking metadata is ignored and thinking text is not emitted as answer content.

## Local Development

Requires Node.js 22 or newer.

```powershell
npm ci
npm run dev
```

Open `http://127.0.0.1:8787`. The development server initializes its own local database and listens only on loopback. Local development has authentication disabled and must not be exposed publicly.

The built-in `ap-demo` model works without an upstream account. Add your own upstream address, API keys and models in the dashboard to use real providers.

## Cloud Deployment

This repository contains placeholder bindings, not a working deployment or any operator credentials.

```powershell
npx wrangler login
npx wrangler d1 create ap-gateway-cloud-db
```

Replace `env.cloud.d1_databases[0].database_id` in `wrangler.jsonc` with the database ID returned for your account. Add your own `account_id` only if your account setup requires it. Custom-domain routes are optional and must reference a domain you control.

For a new deployment, initialize the schema and prepare an administrator password:

```powershell
npm run db:cloud
$env:AP_CLOUD_URL = 'https://gateway.example.com'
node verification/auth-provision.mjs cloud
npx wrangler d1 execute ap-gateway-cloud-db --env cloud --remote --file=.wrangler/auth-provision/cloud/seed.sql
npm run deploy
```

Replace the example URL with your actual deployment origin. The provisioning script generates a random password and stores it outside the repository, by default in your home directory under `.config/ap-gateway/admin-credentials.json`. It prints only the file locations, never the password. Set `AP_ADMIN_CREDENTIALS_FILE` to choose a different external location.

The SQL initializes a new administrator only; it never replaces an existing administrator. Existing installations should change their password in the dashboard. A later dashboard password change does not update the local credentials file automatically.

The cloud configuration enables administrator login and gateway API-key authentication. Do not turn these off for a public deployment. The cloud service rejects private-network upstreams by default.

## Client Access

Log in as the administrator and create a gateway API key in the API-key view. Gateway keys authorize model requests, not administration. They can be restricted to a channel and a model allowlist.

Use `https://gateway.example.com/v1` as the OpenAI-compatible base URL, replacing the example host with your deployment. Authentication supports `Authorization: Bearer`, `x-api-key` and `x-goog-api-key`.

| Protocol | Endpoint |
| --- | --- |
| OpenAI Chat Completions | `POST /v1/chat/completions` |
| OpenAI Responses | `POST /v1/responses` |
| Anthropic Messages | `POST /v1/messages` |
| Gemini | `POST /v1beta/models/{model}:generateContent` |
| Gemini streaming | `POST /v1beta/models/{model}:streamGenerateContent?alt=sse` |
| Model catalogue | `GET /v1/models` and `GET /v1beta/models` |

Optional routing headers are `x-ap-channel`, `x-ap-protocol` and `x-ap-fingerprint`. A fixed channel protocol takes precedence over request protocol overrides.

Channels support multiple upstream keys with per-instance round-robin selection. Protocol retries reuse the same selected key; rate-limit and authentication errors do not trigger automatic key changes. Configuration and authentication caches are per Workers instance, so changes may take up to 60 seconds for configuration and 10 seconds for revoked keys to reach every instance.

Administrator sessions use HttpOnly cookies and CSRF protection. Passwords use salted PBKDF2 hashes. Active gateway API keys are stored in full for administrator retrieval in addition to their verification hashes. Upstream keys are stored in D1, omitted from configuration exports, and never substituted with gateway or session credentials in authenticated deployments.

Streaming responses forward same-protocol bytes unchanged, but complete upstream `error` events are replaced with a redacted error frame so provider error text never reaches clients unfiltered. Converted streams keep text and tool calls in order, deduplicate repeated Gemini function calls, and map Anthropic `model_context_window_exceeded` and `pause_turn` to a truncated result instead of a gateway error.

## Verification

```powershell
npm run typecheck
npm test
npm run build
npm run build:cloud
```

Build commands are dry runs and do not deploy. Local integration tests require `npm run dev` in another terminal:

```powershell
npm run test:integration
npm run test:keys
```

Authentication integration tests use a separate local database and port:

```powershell
node verification/auth-provision.mjs local
npx wrangler d1 execute ap-gateway-db --local --persist-to=.wrangler/auth-verification --file=schema.sql
npx wrangler d1 execute ap-gateway-db --local --persist-to=.wrangler/auth-verification --file=.wrangler/auth-verification/seed.sql
npx wrangler dev --ip=127.0.0.1 --port=8788 --persist-to=.wrangler/auth-verification --var=AUTH_ENABLED:true
```

Then run `npm run test:auth` in another terminal. Cloud tests require `AP_CLOUD_URL` and your own administrator credentials. An optional `AP_WORKERS_URL` enables the second-origin authentication check. Integration tests create and clean up their own temporary channels or keys, but request logs remain.

`test/conversion-regressions.test.ts` covers the streaming and conversion fixes: redacted error frames, Anthropic context-window and pause stop reasons, Gemini thinking metadata, legacy `function_call`, interleaved content ordering, Gemini call deduplication and usage-only chunks.

## Files And Data

- `src/`: gateway routing, configuration, authentication and protocol conversion.
- `public/`: dashboard assets.
- `test/`: unit and routing tests.
- `schema.sql` and `migrations/`: database initialization and upgrades.
- `verification/`: portable local and cloud verification scripts.
- `.wrangler/`: private development databases, generated seed files and runtime state; never commit it.

Use the migration scripts when upgrading an existing database. Back up D1 before schema changes. This is a single-administrator gateway, not a billing or multi-user service.

Personal deployment bindings, operator records, saved page snapshots and private development history are not part of this publication. Do not commit passwords, API keys, credentials files, database snapshots or runtime state.

## Channel Model Discovery

`POST /api/channels/probe` accepts the same fields as channel creation and returns the upstream model list for those values, so a channel can be probed before it is saved. Pass `channelId` to reuse the rest of a saved channel's configuration. Probing uses the first key directly and never advances the key-rotation cursor. The dashboard's probe button replaces the model list with the upstream result instead of merging it, so delisted models do not linger. `POST /api/channels/{id}/probe` keeps the original saved-channel behaviour.

## Version And Readiness

The runtime version lives in `src/version.ts` (`APP_VERSION`, `BUILD_DATE`, `VERSION_TAG`). `package.json`, `package-lock.json` and the runtime constant are kept in sync by `test/version.test.ts`; bump them together for every release.

- `GET /healthz` returns `version`, `build`, `authMode` and `environment` without authentication.
- `GET /readyz` runs `SELECT 1` against D1 and returns 200 with `database: "ok"`, or 503 with `database: "unavailable"`.
- Every response, including errors, redirects and cross-site rejections, carries `x-ap-version: <version> (<build-date>)`.
- The dashboard sidebar shows `v<version> · <build-date>`; hover it for the runtime environment.

Health and readiness responses set `cache-control: no-store`.

## Runtime Panel

The overview page shows a runtime panel backed by `GET /api/runtime` (administrator session required):

- **D1 status**: connection state, per-table row counts, `config` payload size, request-log count and time range. The database file size comes from Cloudflare's metadata API when `CF_API_TOKEN` is set.
- **Workers usage**: requests, 5xx count and durations recorded by the gateway itself for the current UTC day, plus free-plan reference limits. These are not account quota usage.
- **Account-level metrics**: Workers requests/CPU and D1 rows read/written are account-scoped and require a token with Analytics read permission. Without one the panel says so instead of estimating.

Account-level data uses two optional tokens with different scopes:

```powershell
npx wrangler secret put CF_ANALYTICS_TOKEN --env cloud
npx wrangler secret put CF_API_TOKEN --env cloud
```

- `CF_ANALYTICS_TOKEN` needs Account Analytics read access and powers the GraphQL queries for Workers requests/CPU and D1 rows read/written.
- `CF_API_TOKEN` needs D1 read access and is only used to fetch the database `file_size`.

Set `CF_ACCOUNT_ID` and `CF_D1_DATABASE_ID` in the cloud environment to your own values.

## Dashboard Refresh

The dashboard refreshes every 30 seconds, fetching only what the current page shows: the overview polls aggregated statistics and incremental logs, the channels page reads channels and configuration, the logs page pulls only new rows, and the settings page reads configuration alone. Hidden tabs, running tests and open dialogs skip the refresh.

- `GET /api/logs` returns the newest 500 logs with a `cursor`.
- `GET /api/logs?since=<cursor>` returns only rows newer than the cursor; a cleared table or a gap larger than one page returns `reset: true` with the full list.
- `GET /api/status?stats=0` skips the request statistics aggregate and returns version, environment and settings only.

## Contributors

- **weduolijia** — project owner and maintainer.
- **AI assistants** — Codex (OpenAI) and Claude (Anthropic) contributed to this project, including the code work, the credential and history audit, and the preparation of this public release.

## Third-Party Attribution

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for adapted protocol mappings and dependency attribution. The original upstream MIT license is preserved in `vendor/cloudflare-llm-gateway/LICENSE`.
