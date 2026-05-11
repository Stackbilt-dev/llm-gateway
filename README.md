# StackBilt LLM Gateway

A local routing layer that sits between Claude Code (or Codex) and the upstream model providers. Claude Code thinks it is talking to Anthropic. The gateway intercepts each request, classifies the cognitive load, and routes cheap work to Groq or Cerebras — keeping Anthropic in reserve for tool execution and large-context reasoning.

The result: Anthropic tokens spent only when Anthropic is actually needed.

---

## How it works

Every Claude Code request passes through `/v1/messages`. The gateway classifies the request and routes it:

| Route class | Signal | Provider |
|---|---|---|
| `tool_loop` | `tool_result` message in history — Claude is mid-execution | Anthropic |
| `long_context` | Estimated input >12k tokens | Anthropic |
| `planning` | Tools present but no tool loop, reasoning about approach | Groq (`llama-3.3-70b-versatile`) |
| `code_draft` | Code generation intent, no tool loop | Groq |
| `summary` | Summarize / explain / extract | Cerebras (`llama3.1-8b`) |
| `fallback_safe` | Unknown | Anthropic |

**Shadow mode** (on by default): the gateway routes everything to Anthropic but logs what it *would* have routed, and projects savings per turn. Check `/shadow/stats` after a session to see the breakdown. Flip `shadowMode: false` in config to go live.

---

## Setup

### 1. Add API keys

Create `.env` at the repo root (already `.gitignore`d):

```bash
CEREBRAS_API_KEY=csk-...
GROQ_API_KEY=gsk_...

# Optional: route through your own Cloudflare Workers AI account from local Node.
# When these are set, the gateway builds an AI binding shim automatically.
CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_API_TOKEN=...
# Optional override for API base (default: https://api.cloudflare.com/client/v4)
# CLOUDFLARE_API_BASE_URL=https://api.cloudflare.com/client/v4

# Optional: add your personal Anthropic key if you want tool_loop / long_context
# turns to actually hit Anthropic instead of erroring.
# Do NOT use the aegis-web worker key here — that account has no credits.
ANTHROPIC_API_KEY=sk-ant-...
```

`STACKBILT_GATEWAY_KEY` defaults to `local-dev-key` if not set. Override it here if you want a stronger local auth secret.

### 2. Bootstrap setup

```bash
npm run setup
```

### 3. Install global launcher (run once)

```bash
npm run install:global
```

---

## One-command launch (from any repo)

From your project repo (any directory):

```bash
stackbilt-gw claude       # start gateway if needed, then launch Claude via gateway
stackbilt-gw codex        # start gateway if needed, then launch Codex via gateway
```

First-time key setup (interactive prompts):

```bash
stackbilt-gw init
```

If you prefer local repo scripts (while in `llm-gateway`):

```bash
npm run claude
npm run codex
```

Gateway lifecycle commands:

```bash
npm start                        # gateway up
npm run stop                     # gateway down
npm run status                   # up/down + pid/log path
npm run logs                     # tail gateway logs
npm run doctor                   # validate cli/tools/env/provider setup
npm run install:global           # install stackbilt-gw into ~/.local/bin
npm run uninstall:global         # remove global launcher
npm run gateway -- restart       # restart
npm run gateway -- up            # explicit up
npm run gateway -- down          # explicit down
```

Direct script usage:

```bash
./gateway.sh up
./gateway.sh init
./gateway.sh claude
./gateway.sh codex
```

Optional environment overrides:

```bash
STACKBILT_GATEWAY_PORT=9000 npm run claude
STACKBILT_GATEWAY_KEY=my-local-key npm run codex
```

Before first run, check setup (already included in `npm run setup`):

```bash
npm run doctor
```

---

## Manual env mode (optional)

If you prefer manual terminal wiring instead of `npm run claude`:

```bash
export ANTHROPIC_BASE_URL=http://localhost:8787
export ANTHROPIC_API_KEY=local-dev-key
claude
```

---

## Observability

All endpoints except `/health` require the header `x-api-key: local-dev-key` (or whatever `STACKBILT_GATEWAY_KEY` is set to).

### Provider health

```bash
curl http://localhost:8787/providers?live=1 -H "x-api-key: local-dev-key"
```

Shows each provider's circuit-breaker state, error count, and available models.

### Request metrics

```bash
curl http://localhost:8787/metrics -H "x-api-key: local-dev-key"
```

Aggregate counts by provider and route class, average latency, estimated cost.

### Shadow stats (the important one)

```bash
curl http://localhost:8787/shadow/stats -H "x-api-key: local-dev-key"
```

Shows — per route class — how many turns would have been offloaded and the projected USD savings. Use this after a real Claude Code session to decide whether the routing is safe to enable live.

Example output:

```json
{
  "shadowMode": true,
  "totalRequests": 47,
  "shadowedRequests": 31,
  "totalProjectedSavingsUsd": 0.043,
  "byRoute": {
    "planning": { "count": 18, "projectedSavingsUsd": 0.024, "confidence": { "medium": 18 } },
    "summary":  { "count": 13, "projectedSavingsUsd": 0.019, "confidence": { "high": 13 } }
  }
}
```

### Recent events

```bash
curl http://localhost:8787/events/recent -H "x-api-key: local-dev-key"
```

Last 100 requests with full routing metadata.

---

## Enabling live routing

Once you have shadow data you trust, open `packages/llm-gateway/src/config.ts` and set:

```ts
shadowMode: false,
```

Rebuild and restart:

```bash
npm run build && npm start
```

`planning` and `summary` turns now hit Groq/Cerebras live. `tool_loop` and `long_context` still go to Anthropic.

---

## Context compaction

The gateway exposes a dedicated endpoint that distills a Claude Code session transcript into structured facts. Runs on Cerebras (free).

```bash
curl -X POST http://localhost:8787/v1/context/compact \
  -H "Content-Type: application/json" \
  -H "x-api-key: local-dev-key" \
  -d '{
    "messages": [
      {"role": "user", "content": "..."},
      {"role": "assistant", "content": "..."}
    ]
  }'
```

Returns:

```json
{
  "ok": true,
  "provider": "cerebras",
  "compact": {
    "durable_facts": [],
    "decisions_made": [],
    "files_changed": [],
    "open_questions": [],
    "next_actions": [],
    "context_to_discard": ""
  }
}
```

Use this at the end of a long session to extract what actually matters before starting a fresh context.

---

## Troubleshooting

### `stackbilt-gw: command not found`

Install the global launcher and ensure `~/.local/bin` is in your `PATH`:

```bash
npm run install:global
export PATH="$HOME/.local/bin:$PATH"
```

Persist the `PATH` line in `~/.bashrc` or `~/.zshrc`.

### `doctor` fails with missing provider keys

Run interactive setup:

```bash
stackbilt-gw init
```

This writes missing keys to `llm-gateway/.env`.

### `claude` or `codex` binary not found

Install the missing CLI, then re-run:

```bash
stackbilt-gw doctor
```

### Port 8787 already in use

Use another port:

```bash
STACKBILT_GATEWAY_PORT=9000 stackbilt-gw claude
```

### Gateway appears stuck or unhealthy

Check status/logs, then restart:

```bash
stackbilt-gw status
stackbilt-gw logs
stackbilt-gw restart
```

---

## Configuration

The gateway merges config in this order (later wins):

1. Defaults in `packages/llm-gateway/src/config.ts`
2. `gateway.config.json` or `stackbilt.gateway.json` at the working directory
3. CLI flags (`--port`)

Example `gateway.config.json` to flip shadow mode off and adjust routing:

```json
{
  "routing": {
    "shadowMode": false,
    "routes": {
      "planning": ["groq", "cerebras"],
      "summary":  ["cerebras", "groq"]
    }
  }
}
```

To prefer Cloudflare for low-cost classes:

```json
{
  "routing": {
    "routes": {
      "planning": ["cloudflare", "groq", "cerebras"],
      "code_draft": ["cloudflare", "groq", "cerebras"],
      "summary": ["cloudflare", "cerebras", "groq"]
    }
  }
}
```

---

## Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health` | none | Service status, provider availability |
| GET | `/health?live=1` | none | Same + live provider probe |
| GET | `/providers` | key | Provider health snapshot |
| GET | `/providers?live=1` | key | Live provider health |
| GET | `/metrics` | key | Aggregate request metrics |
| GET | `/events/recent` | key | Last 100 request events |
| GET | `/shadow/stats` | key | Shadow routing summary + projected savings |
| POST | `/v1/messages` | key | Anthropic Messages API (Claude Code) |
| POST | `/v1/responses` | key | OpenAI Responses API (Codex) |
| POST | `/v1/chat/completions` | key | OpenAI Chat Completions API |
| POST | `/v1/context/compact` | key | Distill a session transcript to structured facts |
