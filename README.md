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

# Optional: add your personal Anthropic key if you want tool_loop / long_context
# turns to actually hit Anthropic instead of erroring.
# Do NOT use the aegis-web worker key here — that account has no credits.
ANTHROPIC_API_KEY=sk-ant-...
```

`STACKBILT_GATEWAY_KEY` defaults to `local-dev-key` if not set. Override it here if you want a stronger local auth secret.

### 2. Install dependencies

```bash
npm install
```

---

## Starting the gateway

From the repo root:

```bash
npm start            # foreground — logs stream to terminal
npm run start:bg     # background
```

Or directly:

```bash
./start-gateway.sh
./start-gateway.sh --port 9000    # custom port (default: 8787)
```

Verify it's up:

```bash
curl http://localhost:8787/health
```

---

## Pointing Claude Code at the gateway

In any terminal where you launch Claude Code, set two environment variables:

```bash
export ANTHROPIC_BASE_URL=http://localhost:8787
export ANTHROPIC_API_KEY=local-dev-key
```

Then start Claude Code normally:

```bash
claude
```

Claude Code now sends every request to the gateway instead of Anthropic directly. You do not need to change anything else — the gateway speaks the Anthropic Messages protocol.

To stop proxying, unset the variable:

```bash
unset ANTHROPIC_BASE_URL
```

> **Shell tip**: add the two exports to a function in your `~/.bashrc` so you can toggle the gateway on/off in one command:
> ```bash
> gateway-on()  { export ANTHROPIC_BASE_URL=http://localhost:8787; export ANTHROPIC_API_KEY=local-dev-key; }
> gateway-off() { unset ANTHROPIC_BASE_URL; unset ANTHROPIC_API_KEY; }
> ```

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
