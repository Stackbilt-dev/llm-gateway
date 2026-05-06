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

```bash
npm install
npm run build
node packages/llm-gateway/dist/cli.js start --port 8787
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
- If provider keys are missing, request handling returns a provider initialization error (503) so setup issues are visible immediately.
