# @stackbilt/llm-gateway

Local-first model routing gateway for Claude Code, Codex, and future coding-agent CLIs.

## MVP Endpoints

- `GET /health`
- `GET /health?live=1` (optional live provider health probe)
- `GET /providers`
- `GET /providers?live=1` (optional live provider health probe)
- `GET /metrics`
- `GET /events/recent`
- `POST /v1/messages`
- `POST /v1/responses`
- `POST /v1/chat/completions`

## Quick Start

From repo root:

```bash
npm run setup
npm run install:global
stackbilt-gw init
npm start
```

Launch through gateway in one command:

```bash
stackbilt-gw claude
stackbilt-gw codex
```

## Config

The gateway loads config in this order:

1. CLI flags
2. `gateway.config.json`
3. `stackbilt.gateway.json`
4. Defaults in `src/config.ts`

## Notes

- The scaffold includes adapter, routing, telemetry, and cache boundaries.
- `@stackbilt/llm-providers` integration is wired through `LLMProviders.fromEnv(process.env, ...)`.
- Local Cloudflare Workers AI routing is supported via `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` (Node shim creates an `AI.run(...)` compatible binding).
- If provider keys are missing, request handling returns a provider initialization error (503) so setup issues are visible immediately.
