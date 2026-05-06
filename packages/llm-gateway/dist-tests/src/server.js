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
import { classifyRequest } from "./policy/classify.js";
import { selectCompatibleProvider } from "./policy/compatibility.js";
import { routeCandidates } from "./policy/routes.js";
import { getProviderClient } from "./providers/llm-providers.js";
import { EventStore } from "./telemetry/events.js";
import { buildMetrics } from "./telemetry/metrics.js";
import { SQLiteEventSink } from "./telemetry/sqlite-events.js";
function asJsonError(message, type = "invalid_request_error") {
    return {
        error: {
            type,
            message,
        },
    };
}
async function routeViaProviders(request, routeClass, provider, requestId, providerClient) {
    return providerClient.route(request, routeClass, provider, requestId);
}
function estimateCost(event) {
    const inCost = (event.inputTokens ?? 0) * 0.0000007;
    const outCost = (event.outputTokens ?? 0) * 0.0000028;
    return Math.round((inCost + outCost) * 100000) / 100000;
}
function buildContext(pathname) {
    let protocol = "openai-responses";
    let client = "unknown";
    if (pathname === "/v1/messages") {
        protocol = "anthropic-messages";
        client = "claude-code";
    }
    else if (pathname === "/v1/responses") {
        protocol = "openai-responses";
        client = "codex";
    }
    else if (pathname === "/v1/chat/completions") {
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
function buildGatewayEvent(params) {
    const latencyMs = Date.now() - params.context.startTime;
    const event = {
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
    };
    event.costEstimateUsd = estimateCost(event);
    return event;
}
async function parseRequestBody(request) {
    try {
        return (await request.json());
    }
    catch {
        throw new ValidationError("Invalid JSON body");
    }
}
async function executeRequest(params) {
    const routeClass = classifyRequest(params.request);
    const candidates = routeCandidates(routeClass, params.config);
    const provider = selectCompatibleProvider(candidates, params.request, params.context.client, params.config.routing.experimentalModels);
    const prefixKey = buildPrefixCacheKey(params.request);
    if (params.config.cache.prefixCache) {
        params.cache.setPrefix(prefixKey, provider);
    }
    return routeViaProviders(params.request, routeClass, provider, params.context.requestId, params.providerClient);
}
export function createServer(config = resolveConfig(), dependencies = {}) {
    const app = new Hono();
    const events = new EventStore();
    const cache = new SQLiteCache(config.cache.path);
    const eventSink = new SQLiteEventSink(config.telemetry.path);
    const getActiveProviderClient = () => dependencies.providerClient ?? getProviderClient();
    app.onError((error, c) => {
        if (error instanceof GatewayError) {
            return c.json(asJsonError(error.message, error.code), {
                status: error.statusCode,
            });
        }
        if (error instanceof HTTPException) {
            return c.json(asJsonError(error.message, "http_error"), error.status);
        }
        return c.json(asJsonError("Unexpected gateway error", "internal_error"), 500);
    });
    app.get("/health", async (c) => {
        const live = c.req.query("live") === "1" || c.req.query("live") === "true";
        let providerHealth;
        try {
            providerHealth = await getActiveProviderClient().getHealthSnapshot({ live });
        }
        catch (error) {
            const providerError = error;
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
        const input = await parseRequestBody(c.req.raw);
        const llmRequest = anthropicMessagesAdapter.toLLMRequest(input, context);
        const { response, textStream } = await executeRequest({
            config,
            context,
            request: llmRequest,
            cache,
            providerClient: getActiveProviderClient(),
        });
        const routeClass = classifyRequest(llmRequest);
        const event = buildGatewayEvent({
            context,
            routeClass,
            response,
            status: response.fallbackChain.length > 1 ? "fallback_success" : "success",
        });
        if (config.telemetry.redactSecrets) {
            event.selectedModel = redactSecrets(event.selectedModel);
        }
        events.append(event);
        eventSink.write(event);
        if (llmRequest.stream) {
            const out = anthropicMessagesAdapter.fromLLMStream?.(textStream, context);
            return new Response(out, {
                status: 200,
                headers: {
                    "content-type": "text/event-stream",
                    "cache-control": "no-cache",
                    connection: "keep-alive",
                },
            });
        }
        return c.json(anthropicMessagesAdapter.fromLLMResponse(response, context));
    });
    app.post("/v1/responses", async (c) => {
        const context = buildContext(c.req.path);
        const input = await parseRequestBody(c.req.raw);
        const llmRequest = openAIResponsesAdapter.toLLMRequest(input, context);
        const { response, textStream } = await executeRequest({
            config,
            context,
            request: llmRequest,
            cache,
            providerClient: getActiveProviderClient(),
        });
        const routeClass = classifyRequest(llmRequest);
        const event = buildGatewayEvent({
            context,
            routeClass,
            response,
            status: response.fallbackChain.length > 1 ? "fallback_success" : "success",
        });
        events.append(event);
        eventSink.write(event);
        if (llmRequest.stream) {
            const out = openAIResponsesAdapter.fromLLMStream?.(textStream, context);
            return new Response(out, {
                status: 200,
                headers: {
                    "content-type": "text/event-stream",
                    "cache-control": "no-cache",
                    connection: "keep-alive",
                },
            });
        }
        return c.json(openAIResponsesAdapter.fromLLMResponse(response, context));
    });
    app.post("/v1/chat/completions", async (c) => {
        const context = buildContext(c.req.path);
        const input = await parseRequestBody(c.req.raw);
        const llmRequest = openAIChatCompletionsAdapter.toLLMRequest(input, context);
        const { response, textStream } = await executeRequest({
            config,
            context,
            request: llmRequest,
            cache,
            providerClient: getActiveProviderClient(),
        });
        const routeClass = classifyRequest(llmRequest);
        const event = buildGatewayEvent({
            context,
            routeClass,
            response,
            status: response.fallbackChain.length > 1 ? "fallback_success" : "success",
        });
        events.append(event);
        eventSink.write(event);
        if (llmRequest.stream) {
            const out = openAIChatCompletionsAdapter.fromLLMStream?.(textStream, context);
            return new Response(out, {
                status: 200,
                headers: {
                    "content-type": "text/event-stream",
                    "cache-control": "no-cache",
                    connection: "keep-alive",
                },
            });
        }
        return c.json(openAIChatCompletionsAdapter.fromLLMResponse(response, context));
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
