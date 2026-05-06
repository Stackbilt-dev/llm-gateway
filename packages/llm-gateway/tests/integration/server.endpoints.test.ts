import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "../../src/server.js";
import { GatewayConfig, LLMRequest, LLMResponse, RouteClass } from "../../src/types.js";
import { ProviderClient, ProviderHealthSnapshot, ProviderRouteResult } from "../../src/providers/llm-providers.js";

function buildConfig(): GatewayConfig {
  return {
    port: 8787,
    auth: {
      mode: "local-key",
      keys: ["test-key"],
    },
    routing: {
      default: "auto",
      experimentalModels: false,
      routes: {
        cheap_edit: ["cloudflare", "groq", "cerebras"],
        fast_code: ["groq", "cerebras", "cloudflare"],
        deep_reasoning: ["anthropic", "openai", "cerebras"],
        tool_heavy: ["anthropic", "openai"],
        long_context: ["anthropic", "openai"],
        fallback_safe: ["anthropic", "openai"],
      },
    },
    cache: {
      enabled: true,
      storage: "sqlite",
      path: ".stackbilt/gateway/test-cache.sqlite",
      responseCache: false,
      prefixCache: true,
    },
    telemetry: {
      enabled: true,
      storePrompts: false,
      redactSecrets: true,
      path: ".stackbilt/gateway/test-events.sqlite",
    },
  };
}

class MockProviderClient implements ProviderClient {
  public readonly calls: Array<{
    request: LLMRequest;
    routeClass: RouteClass;
    preferredProvider: string;
    requestId: string;
  }> = [];

  async route(
    request: LLMRequest,
    routeClass: RouteClass,
    preferredProvider: string,
    requestId: string,
  ): Promise<ProviderRouteResult> {
    this.calls.push({ request, routeClass, preferredProvider, requestId });

    const response: LLMResponse = {
      id: requestId,
      provider: preferredProvider,
      model: request.model ?? "mock-model",
      outputText: "mock-output",
      usage: {
        inputTokens: 11,
        outputTokens: 4,
      },
      fallbackChain: [preferredProvider],
      routeClass,
      cacheHit: false,
    };

    const textStream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue("mock-");
        controller.enqueue("output");
        controller.close();
      },
    });

    return { response, textStream };
  }

  async getHealthSnapshot(options?: { live?: boolean }): Promise<ProviderHealthSnapshot> {
    return {
      configured: true,
      availableProviders: ["anthropic", "openai"],
      status: options?.live ? "degraded" : "ok",
      healthyProviders: ["anthropic"],
      unhealthyProviders: options?.live ? ["openai"] : [],
    };
  }
}

function authHeaders() {
  return {
    "content-type": "application/json",
    "x-api-key": "test-key",
  };
}

function assertSsePayload(payload: string, eventName: string) {
  assert.match(payload, new RegExp(`event: ${eventName}`));
  assert.match(payload, /data: mock-/);
  assert.match(payload, /data: output/);
  assert.match(payload, /event: done/);
  assert.match(payload, /data: \[DONE\]/);
}

test("health includes provider snapshot and supports live query", async () => {
  const providerClient = new MockProviderClient();
  const { app } = createServer(buildConfig(), { providerClient });

  const basic = await app.request("http://localhost/health");
  assert.equal(basic.status, 200);
  const basicJson = (await basic.json()) as { status: string; providers: ProviderHealthSnapshot };
  assert.equal(basicJson.status, "up");
  assert.equal(basicJson.providers.status, "ok");

  const live = await app.request("http://localhost/health?live=1");
  assert.equal(live.status, 200);
  const liveJson = (await live.json()) as { status: string; providers: ProviderHealthSnapshot };
  assert.equal(liveJson.status, "degraded");
  assert.deepEqual(liveJson.providers.unhealthyProviders, ["openai"]);
});

test("providers endpoint returns provider health snapshot and requires auth", async () => {
  const providerClient = new MockProviderClient();
  const { app } = createServer(buildConfig(), { providerClient });

  const unauthenticated = await app.request("http://localhost/providers");
  assert.equal(unauthenticated.status, 401);

  const response = await app.request("http://localhost/providers?live=1", {
    headers: { "x-api-key": "test-key" },
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { providers: ProviderHealthSnapshot };
  assert.equal(body.providers.status, "degraded");
  assert.deepEqual(body.providers.availableProviders, ["anthropic", "openai"]);
});

test("responses endpoint maps protocol and records metrics/events", async () => {
  const providerClient = new MockProviderClient();
  const { app } = createServer(buildConfig(), { providerClient });

  const response = await app.request("http://localhost/v1/responses", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      model: "gpt-5",
      input: "explain this code",
      stream: false,
    }),
  });

  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    object: string;
    output: Array<{ content: Array<{ text: string }> }>;
  };
  assert.equal(body.object, "response");
  assert.equal(body.output[0].content[0].text, "mock-output");
  assert.equal(providerClient.calls.length, 1);
  assert.equal(providerClient.calls[0].routeClass, "cheap_edit");

  const metricsResponse = await app.request("http://localhost/metrics", {
    headers: { "x-api-key": "test-key" },
  });
  const metrics = (await metricsResponse.json()) as { totalRequests: number; byProvider: Record<string, number> };
  assert.equal(metrics.totalRequests, 1);
  assert.equal(metrics.byProvider.cloudflare, 1);

  const eventsResponse = await app.request("http://localhost/events/recent", {
    headers: { "x-api-key": "test-key" },
  });
  const events = (await eventsResponse.json()) as {
    events: Array<{ protocol: string; selectedProvider: string }>;
  };
  assert.equal(events.events.length, 1);
  assert.equal(events.events[0].protocol, "openai-responses");
  assert.equal(events.events[0].selectedProvider, "cloudflare");
});

test("anthropic messages with tools route via tool-safe provider", async () => {
  const providerClient = new MockProviderClient();
  const { app } = createServer(buildConfig(), { providerClient });

  const response = await app.request("http://localhost/v1/messages", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      model: "claude-sonnet-4-6-20250618",
      messages: [{ role: "user", content: "Use a tool to fetch info" }],
      tools: [
        {
          name: "lookup",
          description: "Lookup data",
          input_schema: {
            type: "object",
            properties: { key: { type: "string" } },
            required: ["key"],
          },
        },
      ],
      stream: false,
    }),
  });

  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    role: string;
    content: Array<{ text: string }>;
  };
  assert.equal(body.role, "assistant");
  assert.equal(body.content[0].text, "mock-output");
  assert.equal(providerClient.calls[0].routeClass, "tool_heavy");
  assert.equal(providerClient.calls[0].preferredProvider, "anthropic");
});

test("streaming is exposed as SSE for all protocol endpoints", async () => {
  const providerClient = new MockProviderClient();
  const { app } = createServer(buildConfig(), { providerClient });

  const anthropicStream = await app.request("http://localhost/v1/messages", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      model: "claude-sonnet-4-6-20250618",
      messages: [{ role: "user", content: "stream please" }],
      stream: true,
    }),
  });
  assert.equal(anthropicStream.status, 200);
  assert.match(anthropicStream.headers.get("content-type") ?? "", /^text\/event-stream/);
  assertSsePayload(await anthropicStream.text(), "message");

  const responsesStream = await app.request("http://localhost/v1/responses", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      model: "gpt-5",
      input: "stream this",
      stream: true,
    }),
  });
  assert.equal(responsesStream.status, 200);
  assert.match(responsesStream.headers.get("content-type") ?? "", /^text\/event-stream/);
  assertSsePayload(await responsesStream.text(), "response.output_text.delta");

  const chatStream = await app.request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      model: "gpt-5",
      messages: [{ role: "user", content: "stream chat" }],
      stream: true,
    }),
  });
  assert.equal(chatStream.status, 200);
  assert.match(chatStream.headers.get("content-type") ?? "", /^text\/event-stream/);
  assertSsePayload(await chatStream.text(), "chat.completion.chunk");
});
