import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { authMiddleware } from "./auth.js";
import { resolveConfig } from "./config.js";
import { GatewayError, ValidationError } from "./errors.js";
import { anthropicMessagesAdapter } from "./adapters/anthropic-messages.js";
import { openAIChatCompletionsAdapter } from "./adapters/openai-chat.js";
import { openAIResponsesAdapter } from "./adapters/openai-responses.js";
import { buildPrefixCacheKey } from "./cache/keys.js";
import { redactSecrets } from "./cache/redaction.js";
import { SQLiteCache } from "./cache/sqlite-cache.js";
import { classifyRequest, computeShadowDecision, type ShadowDecision } from "./policy/classify.js";
import { selectCompatibleProvider } from "./policy/compatibility.js";
import { routeCandidates } from "./policy/routes.js";
import { getProviderClient, type ProviderClient } from "./providers/llm-providers.js";
import { EventStore } from "./telemetry/events.js";
import { buildMetrics } from "./telemetry/metrics.js";
import { SQLiteEventSink } from "./telemetry/sqlite-events.js";
import {
  GatewayConfig,
  GatewayRequestContext,
  GatewayRequestEvent,
  LLMRequest,
  LLMResponse,
  RouteClass,
} from "./types.js";

interface RouteOutput {
  response: LLMResponse;
  textStream: ReadableStream<string>;
  routeClass: RouteClass;
  shadow?: ShadowDecision;
}

interface ServerDependencies {
  providerClient?: ProviderClient;
}

function asJsonError(message: string, type = "invalid_request_error") {
  return {
    error: {
      type,
      message,
    },
  };
}

async function routeViaProviders(
  request: LLMRequest,
  routeClass: RouteClass,
  provider: string,
  requestId: string,
  providerClient: ProviderClient,
): Promise<RouteOutput> {
  const result = await providerClient.route(request, routeClass, provider, requestId);
  return { ...result, routeClass };
}

function estimateCost(event: Pick<GatewayRequestEvent, "inputTokens" | "outputTokens">): number {
  const inCost = (event.inputTokens ?? 0) * 0.0000007;
  const outCost = (event.outputTokens ?? 0) * 0.0000028;
  return Math.round((inCost + outCost) * 100000) / 100000;
}

function buildContext(pathname: string): GatewayRequestContext {
  let protocol: GatewayRequestContext["protocol"] = "openai-responses";
  let client: GatewayRequestContext["client"] = "unknown";

  if (pathname === "/v1/messages") {
    protocol = "anthropic-messages";
    client = "claude-code";
  } else if (pathname === "/v1/responses") {
    protocol = "openai-responses";
    client = "codex";
  } else if (pathname === "/v1/chat/completions") {
    protocol = "openai-chat";
    client = "codex";
  }

  return {
    requestId: crypto.randomUUID(),
    protocol,
    client,
    startTime: Date.now(),
    requestPath: pathname,
  };
}

function buildGatewayEvent(params: {
  context: GatewayRequestContext;
  routeClass: RouteClass;
  response: LLMResponse;
  status: GatewayRequestEvent["status"];
  errorClass?: string;
  shadow?: ShadowDecision;
}): GatewayRequestEvent {
  const latencyMs = Date.now() - params.context.startTime;

  const event: GatewayRequestEvent = {
    id: params.context.requestId,
    timestamp: new Date().toISOString(),
    client: params.context.client,
    protocol: params.context.protocol,
    sessionId: params.context.sessionId,
    repoPath: params.context.repoPath,
    routeClass: params.routeClass,
    requestedModel: params.response.model,
    selectedProvider: params.response.provider,
    selectedModel: params.response.model,
    fallbackChain: params.response.fallbackChain,
    inputTokens: params.response.usage?.inputTokens,
    outputTokens: params.response.usage?.outputTokens,
    cachedInputTokens: params.response.usage?.cachedInputTokens,
    costEstimateUsd: 0,
    latencyMs,
    cacheHit: params.response.cacheHit,
    status: params.status,
    errorClass: params.errorClass,
    shadowRoute: params.shadow?.wouldRoute,
    shadowProvider: params.shadow?.wouldProvider,
    shadowConfidence: params.shadow?.confidence,
    projectedSavingsUsd: params.shadow?.projectedSavingsUsd,
  };

  event.costEstimateUsd = estimateCost(event);
  return event;
}

async function parseRequestBody<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new ValidationError("Invalid JSON body");
  }
}

async function executeRequest(params: {
  config: GatewayConfig;
  context: GatewayRequestContext;
  request: LLMRequest;
  cache: SQLiteCache;
  providerClient: ProviderClient;
}): Promise<RouteOutput> {
  const classifiedRoute = classifyRequest(params.request);
  const shadowMode = params.config.routing.shadowMode;

  // In shadow mode: always route to fallback_safe (Anthropic) but log the classifier decision
  const activeRoute: RouteClass = shadowMode && classifiedRoute !== "tool_loop" && classifiedRoute !== "long_context" && classifiedRoute !== "fallback_safe"
    ? "fallback_safe"
    : classifiedRoute;

  const candidates = routeCandidates(activeRoute, params.config);
  const provider = selectCompatibleProvider(
    candidates,
    params.request,
    params.context.client,
    params.config.routing.experimentalModels,
  );

  const prefixKey = buildPrefixCacheKey(params.request);
  if (params.config.cache.prefixCache) {
    params.cache.setPrefix(prefixKey, provider);
  }

  // Compute shadow decision for cheap route classes so the event log shows projected savings
  let shadow: ShadowDecision | undefined;
  if (shadowMode && activeRoute !== classifiedRoute) {
    const shadowCandidates = routeCandidates(classifiedRoute, params.config);
    const shadowProvider = shadowCandidates[0] ?? provider;
    shadow = computeShadowDecision(params.request, classifiedRoute, shadowProvider);
  }

  const result = await routeViaProviders(
    params.request,
    activeRoute,
    provider,
    params.context.requestId,
    params.providerClient,
  );

  return { ...result, routeClass: activeRoute, shadow };
}

export function createServer(config = resolveConfig(), dependencies: ServerDependencies = {}) {
  const app = new Hono();
  const events = new EventStore();
  const cache = new SQLiteCache(config.cache.path);
  const eventSink = new SQLiteEventSink(config.telemetry.path);
  const getActiveProviderClient = (): ProviderClient => dependencies.providerClient ?? getProviderClient();

  app.onError((error, c) => {
    if (error instanceof GatewayError) {
      return c.json(asJsonError(error.message, error.code), {
        status: error.statusCode as 400 | 401 | 403 | 404 | 429 | 500,
      });
    }

    if (error instanceof HTTPException) {
      return c.json(asJsonError(error.message, "http_error"), error.status);
    }

    return c.json(asJsonError("Unexpected gateway error", "internal_error"), 500);
  });

  app.get("/health", async (c) => {
    const live = c.req.query("live") === "1" || c.req.query("live") === "true";
    let providerHealth: Awaited<ReturnType<ProviderClient["getHealthSnapshot"]>>;

    try {
      providerHealth = await getActiveProviderClient().getHealthSnapshot({ live });
    } catch (error) {
      const providerError = error as { message?: string };
      providerHealth = {
        configured: false,
        availableProviders: [],
        status: "unconfigured",
        error: providerError.message ?? "provider client unavailable",
      };
    }

    return c.json({
      ok: true,
      status: providerHealth.status === "degraded" ? "degraded" : "up",
      service: "@stackbilt/llm-gateway",
      version: "0.1.0",
      timestamp: new Date().toISOString(),
      providers: providerHealth,
    });
  });

  app.use("*", async (c, next) => {
    if (c.req.path === "/health") {
      await next();
      return;
    }
    return authMiddleware(config)(c, next);
  });

  app.get("/metrics", (c) => {
    const metrics = buildMetrics(events.all());
    return c.json(metrics);
  });

  app.get("/providers", async (c) => {
    const live = c.req.query("live") === "1" || c.req.query("live") === "true";
    const providers = await getActiveProviderClient().getHealthSnapshot({ live });

    return c.json({
      providers,
      timestamp: new Date().toISOString(),
    });
  });

  app.get("/events/recent", (c) => c.json({ events: events.recent(100) }));

  app.post("/v1/messages", async (c) => {
    const context = buildContext(c.req.path);
    const input = await parseRequestBody<Record<string, unknown>>(c.req.raw);
    const llmRequest = anthropicMessagesAdapter.toLLMRequest(input as never, context);

    const result = await executeRequest({
      config,
      context,
      request: llmRequest,
      cache,
      providerClient: getActiveProviderClient(),
    });

    const event = buildGatewayEvent({
      context,
      routeClass: result.routeClass,
      response: result.response,
      status: result.response.fallbackChain.length > 1 ? "fallback_success" : "success",
      shadow: result.shadow,
    });

    if (config.telemetry.redactSecrets) {
      event.selectedModel = redactSecrets(event.selectedModel);
    }

    events.append(event);
    eventSink.write(event);

    if (llmRequest.stream) {
      const out = anthropicMessagesAdapter.fromLLMStream?.(result.textStream, context);
      return new Response(out, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    }

    return c.json(anthropicMessagesAdapter.fromLLMResponse(result.response, context));
  });

  app.post("/v1/responses", async (c) => {
    const context = buildContext(c.req.path);
    const input = await parseRequestBody<Record<string, unknown>>(c.req.raw);
    const llmRequest = openAIResponsesAdapter.toLLMRequest(input as never, context);

    const result = await executeRequest({
      config,
      context,
      request: llmRequest,
      cache,
      providerClient: getActiveProviderClient(),
    });

    const event = buildGatewayEvent({
      context,
      routeClass: result.routeClass,
      response: result.response,
      status: result.response.fallbackChain.length > 1 ? "fallback_success" : "success",
      shadow: result.shadow,
    });

    events.append(event);
    eventSink.write(event);

    if (llmRequest.stream) {
      const out = openAIResponsesAdapter.fromLLMStream?.(result.textStream, context);
      return new Response(out, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    }

    return c.json(openAIResponsesAdapter.fromLLMResponse(result.response, context));
  });

  app.post("/v1/chat/completions", async (c) => {
    const context = buildContext(c.req.path);
    const input = await parseRequestBody<Record<string, unknown>>(c.req.raw);
    const llmRequest = openAIChatCompletionsAdapter.toLLMRequest(input as never, context);

    const result = await executeRequest({
      config,
      context,
      request: llmRequest,
      cache,
      providerClient: getActiveProviderClient(),
    });

    const event = buildGatewayEvent({
      context,
      routeClass: result.routeClass,
      response: result.response,
      status: result.response.fallbackChain.length > 1 ? "fallback_success" : "success",
      shadow: result.shadow,
    });

    events.append(event);
    eventSink.write(event);

    if (llmRequest.stream) {
      const out = openAIChatCompletionsAdapter.fromLLMStream?.(result.textStream, context);
      return new Response(out, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    }

    return c.json(openAIChatCompletionsAdapter.fromLLMResponse(result.response, context));
  });

  // Shadow stats: aggregate projected savings and route distribution from in-memory events
  app.get("/shadow/stats", (c) => {
    const all = events.all();
    const shadowed = all.filter((e) => e.shadowRoute !== undefined);

    const byRoute: Record<string, { count: number; projectedSavingsUsd: number; confidence: Record<string, number> }> = {};
    let totalProjected = 0;

    for (const e of shadowed) {
      const key = e.shadowRoute!;
      if (!byRoute[key]) byRoute[key] = { count: 0, projectedSavingsUsd: 0, confidence: {} };
      byRoute[key].count++;
      byRoute[key].projectedSavingsUsd += e.projectedSavingsUsd ?? 0;
      byRoute[key].confidence[e.shadowConfidence ?? "unknown"] = (byRoute[key].confidence[e.shadowConfidence ?? "unknown"] ?? 0) + 1;
      totalProjected += e.projectedSavingsUsd ?? 0;
    }

    return c.json({
      shadowMode: config.routing.shadowMode,
      totalRequests: all.length,
      shadowedRequests: shadowed.length,
      totalProjectedSavingsUsd: Math.round(totalProjected * 100000) / 100000,
      byRoute,
      recentShadow: shadowed.slice(-20).reverse().map((e) => ({
        id: e.id,
        timestamp: e.timestamp,
        actualRoute: e.routeClass,
        shadowRoute: e.shadowRoute,
        shadowProvider: e.shadowProvider,
        confidence: e.shadowConfidence,
        projectedSavingsUsd: e.projectedSavingsUsd,
      })),
    });
  });

  // Context compaction: distill a conversation into durable facts + next actions
  app.post("/v1/context/compact", async (c) => {
    const input = await parseRequestBody<{
      messages: Array<{ role: string; content: string }>;
      system?: string;
    }>(c.req.raw);

    const transcript = input.messages
      .map((m) => `[${m.role.toUpperCase()}]: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`)
      .join("\n\n");

    const compactRequest: LLMRequest = {
      messages: [
        {
          role: "user",
          content: `Extract the essential structure from this AI coding session transcript. Return ONLY valid JSON matching this schema — no prose, no markdown:

{
  "durable_facts": [],
  "decisions_made": [],
  "files_changed": [],
  "open_questions": [],
  "next_actions": [],
  "context_to_discard": ""
}

TRANSCRIPT:
${transcript.slice(0, 32_000)}`,
        },
      ],
      maxTokens: 1200,
      temperature: 0.1,
    };

    const requestId = crypto.randomUUID();
    const providerClient = getActiveProviderClient();

    try {
      const { response } = await providerClient.route(compactRequest, "summary", "cerebras", requestId);

      let parsed: unknown;
      try {
        const jsonMatch = response.outputText.match(/\{[\s\S]*\}/);
        parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { raw: response.outputText };
      } catch {
        parsed = { raw: response.outputText };
      }

      return c.json({
        ok: true,
        provider: response.provider,
        model: response.model,
        inputTokensEstimate: Math.ceil(transcript.length / 4),
        compact: parsed,
      });
    } catch (error) {
      const err = error as { message?: string };
      return c.json({ ok: false, error: err.message ?? "compaction failed" }, 500);
    }
  });

  return {
    app,
    config,
  };
}

export async function startServer(config = resolveConfig()) {
  const { app } = createServer(config);
  const server = serve({
    fetch: app.fetch,
    port: config.port,
  });

  return server;
}
