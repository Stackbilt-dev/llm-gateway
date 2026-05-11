import type {
  LLMRequest as ProviderRequest,
  LLMResponse as ProviderResponse,
  ObservabilityHooks,
  ProviderHealthEntry,
  ProviderName,
  Tool,
} from "@stackbilt/llm-providers";
import { GatewayError } from "../errors.js";
import { LLMMessage, LLMRequest, LLMResponse, RouteClass } from "../types.js";
import { createCloudflareAiBinding } from "./cloudflare-ai-binding.js";

const PROVIDER_NAMES: ProviderName[] = ["openai", "anthropic", "cloudflare", "cerebras", "groq"];

type ProvidersModule = {
  LLMProviders: {
    fromEnv(env: Record<string, unknown>, overrides: Record<string, unknown>): LLMProvidersInstance;
  };
  getProviderDefaultModel(provider: ProviderName, request?: Partial<ProviderRequest>): string;
};

type LLMProvidersInstance = {
  generateResponse(request: ProviderRequest): Promise<ProviderResponse>;
  generateResponseStream(request: ProviderRequest): Promise<ReadableStream<string>>;
  getAvailableProviders(): string[];
  getHealth(): Promise<Record<string, ProviderHealthEntry>>;
};

interface PendingRequestMeta {
  requestedProvider: string;
  lastStartedProvider?: string;
  lastStartedModel?: string;
}

export interface ProviderRouteResult {
  response: LLMResponse;
  textStream: ReadableStream<string>;
}

export interface ProviderHealthSnapshot {
  configured: boolean;
  availableProviders: string[];
  status: "unconfigured" | "ok" | "degraded";
  healthyProviders?: string[];
  unhealthyProviders?: string[];
  detail?: Record<string, ProviderHealthEntry>;
  error?: string;
}

export interface ProviderClient {
  route(request: LLMRequest, routeClass: RouteClass, preferredProvider: string, requestId: string): Promise<ProviderRouteResult>;
  getHealthSnapshot(options?: { live?: boolean }): Promise<ProviderHealthSnapshot>;
}

let providersModulePromise: Promise<ProvidersModule> | null = null;

function loadProvidersModule(): Promise<ProvidersModule> {
  if (!providersModulePromise) {
    providersModulePromise = import("@stackbilt/llm-providers") as Promise<ProvidersModule>;
  }

  return providersModulePromise;
}

function toStream(text: string, chunkSize = 40): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      let index = 0;
      while (index < text.length) {
        controller.enqueue(text.slice(index, index + chunkSize));
        index += chunkSize;
      }
      controller.close();
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeToolParameters(inputSchema: unknown): Tool["function"]["parameters"] {
  if (isRecord(inputSchema) && inputSchema.type === "object" && isRecord(inputSchema.properties)) {
    return {
      type: "object",
      properties: inputSchema.properties,
      required: Array.isArray(inputSchema.required)
        ? inputSchema.required.filter((item): item is string => typeof item === "string")
        : undefined,
    };
  }

  return {
    type: "object",
    properties: {},
  };
}

function normalizeToolChoice(toolChoice: LLMRequest["toolChoice"]): ProviderRequest["toolChoice"] {
  if (toolChoice === "none") return "none";
  if (toolChoice === "auto" || toolChoice === "any" || toolChoice === undefined) return "auto";

  if (typeof toolChoice === "string") {
    return {
      type: "function",
      function: {
        name: toolChoice,
      },
    };
  }

  if (isRecord(toolChoice)) {
    const functionValue = toolChoice.function;
    if (isRecord(functionValue) && typeof functionValue.name === "string") {
      return {
        type: "function",
        function: {
          name: functionValue.name,
        },
      };
    }
  }

  return "auto";
}

function normalizeMessage(message: LLMMessage): ProviderRequest["messages"][number] {
  if (message.role === "tool") {
    const name = message.name ? ` (${message.name})` : "";
    return {
      role: "user",
      content: `Tool result${name}:\n${message.content}`,
    };
  }

  return {
    role: message.role,
    content: message.content,
  };
}

function normalizeTools(inputTools: LLMRequest["tools"]): ProviderRequest["tools"] {
  if (!inputTools?.length) return undefined;

  return inputTools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description ?? "Gateway forwarded tool",
      parameters: normalizeToolParameters(tool.inputSchema),
    },
  }));
}

function providerNameOrNull(input: string): ProviderName | null {
  return PROVIDER_NAMES.find((provider) => provider === input) ?? null;
}

function detectConfiguredProvidersFromEnv(env: NodeJS.ProcessEnv): string[] {
  const configured: string[] = [];

  if (env.ANTHROPIC_API_KEY) configured.push("anthropic");
  if (env.OPENAI_API_KEY) configured.push("openai");
  if (env.GROQ_API_KEY) configured.push("groq");
  if (env.CEREBRAS_API_KEY) configured.push("cerebras");
  if (env.AI) configured.push("cloudflare");
  if (env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN) configured.push("cloudflare");

  return configured;
}

class GatewayProviderClient implements ProviderClient {
  private llm: LLMProvidersInstance | null = null;
  private readonly pending = new Map<string, PendingRequestMeta>();
  private readonly fallbackByRequestId = new Map<string, string[]>();

  private async getLLM(): Promise<LLMProvidersInstance> {
    if (this.llm) return this.llm;

    try {
      const providersModule = await loadProvidersModule();
      const hooks: ObservabilityHooks = {
        onFallback: (event) => {
          if (!event.requestId) return;
          const existing = this.fallbackByRequestId.get(event.requestId) ?? [event.fromProvider];
          existing.push(event.toProvider);
          this.fallbackByRequestId.set(event.requestId, existing);
        },
        onRequestStart: (event) => {
          if (!event.requestId) return;
          const pending = this.pending.get(event.requestId);
          if (!pending) return;
          pending.lastStartedProvider = event.provider;
          pending.lastStartedModel = event.model;
        },
      };

      const envForProviders: Record<string, unknown> = { ...(process.env as Record<string, unknown>) };
      const hasCloudflareBinding = typeof envForProviders.AI === "object" && envForProviders.AI !== null;
      const cloudflareAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
      const cloudflareApiToken = process.env.CLOUDFLARE_API_TOKEN;

      if (!hasCloudflareBinding && cloudflareAccountId && cloudflareApiToken) {
        envForProviders.AI = createCloudflareAiBinding({
          accountId: cloudflareAccountId,
          apiToken: cloudflareApiToken,
          apiBaseUrl: process.env.CLOUDFLARE_API_BASE_URL,
        });
      }

      this.llm = providersModule.LLMProviders.fromEnv(envForProviders, {
        defaultProvider: "auto",
        costOptimization: false,
        enableCircuitBreaker: true,
        enableRetries: true,
        hooks,
      });

      return this.llm;
    } catch (error) {
      const providerError = error as { message?: string };
      throw new GatewayError(
        providerError.message ?? "No LLM providers configured from environment",
        "provider_init_error",
        503,
      );
    }
  }

  private consumeFallbackChain(requestId: string, finalProvider: string): string[] {
    const fallbacks = this.fallbackByRequestId.get(requestId) ?? [];
    this.fallbackByRequestId.delete(requestId);

    if (fallbacks.length === 0) return [finalProvider];

    if (fallbacks[fallbacks.length - 1] !== finalProvider) {
      fallbacks.push(finalProvider);
    }

    return fallbacks;
  }

  private async buildProviderRequest(
    request: LLMRequest,
    preferredProvider: string,
    requestId: string,
  ): Promise<ProviderRequest> {
    const preferredProviderName = providerNameOrNull(preferredProvider);

    const providerRequest: ProviderRequest = {
      requestId,
      messages: request.messages.map(normalizeMessage),
      systemPrompt: request.system,
      model: request.model,
      temperature: request.temperature,
      maxTokens: request.maxTokens,
      stream: request.stream,
      tools: normalizeTools(request.tools),
      toolChoice: normalizeToolChoice(request.toolChoice),
      metadata: request.metadata,
    };

    const cheapProviders = new Set<ProviderName>(["groq", "cerebras", "cloudflare"]);

    // Preferred model for each cheap provider — bypasses getProviderDefaultModel which
    // optimizes for COST_EFFECTIVE and always picks llama-3.1-8b on Cerebras, ignoring
    // the PAYG account's better models.
    // Note: zai-glm-4.7 is a thinking/reasoning model — it exhausts short token budgets
    // on internal reasoning before producing output, causing SCHEMA_DRIFT on cheap routes.
    // qwen-3-235b is the right conversational model for PAYG Cerebras.
    const preferredModel: Partial<Record<ProviderName, string>> = {
      groq: "llama-3.3-70b-versatile",
      cerebras: "qwen-3-235b-a22b-instruct-2507",
    };

    // Strip tools BEFORE model override so getProviderDefaultModel infers BALANCED
    // (not TOOL_CALLING), which picks a text model rather than a tool-calling specialist.
    if (preferredProviderName && cheapProviders.has(preferredProviderName)) {
      providerRequest.tools = undefined;
      providerRequest.toolChoice = undefined;
    }

    if (preferredProviderName && cheapProviders.has(preferredProviderName)) {
      providerRequest.model = preferredModel[preferredProviderName]
        ?? (await loadProvidersModule()).getProviderDefaultModel(preferredProviderName, providerRequest);
    } else if (!providerRequest.model) {
      providerRequest.model = (await loadProvidersModule()).getProviderDefaultModel(
        preferredProviderName ?? "anthropic",
        providerRequest,
      );
    }

    return providerRequest;
  }

  async route(request: LLMRequest, routeClass: RouteClass, preferredProvider: string, requestId: string): Promise<ProviderRouteResult> {
    const llm = await this.getLLM();
    const providerRequest = await this.buildProviderRequest(request, preferredProvider, requestId);
    this.pending.set(requestId, {
      requestedProvider: preferredProvider,
    });

    try {
      if (request.stream) {
        const stream = await llm.generateResponseStream(providerRequest);
        const pending = this.pending.get(requestId);
        const selectedProvider = pending?.lastStartedProvider ?? preferredProvider;
        const selectedModel = pending?.lastStartedModel ?? providerRequest.model ?? "stackbilt-auto";

        const response: LLMResponse = {
          id: requestId,
          provider: selectedProvider,
          model: selectedModel,
          outputText: "",
          usage: undefined,
          fallbackChain: this.consumeFallbackChain(requestId, selectedProvider),
          routeClass,
          cacheHit: false,
        };

        return {
          response,
          textStream: stream,
        };
      }

      const providerResponse = await llm.generateResponse(providerRequest);
      return {
        response: this.toGatewayResponse(providerResponse, routeClass, requestId, preferredProvider),
        textStream: toStream(providerResponse.message ?? providerResponse.content ?? ""),
      };
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      const providerError = error as { message?: string; statusCode?: number; code?: string };
      throw new GatewayError(
        providerError.message ?? "Provider request failed",
        providerError.code ?? "provider_error",
        providerError.statusCode ?? 502,
      );
    } finally {
      this.pending.delete(requestId);
    }
  }

  async getHealthSnapshot(options?: { live?: boolean }): Promise<ProviderHealthSnapshot> {
    const live = options?.live ?? false;
    const configuredFromEnv = detectConfiguredProvidersFromEnv(process.env);
    const configured = configuredFromEnv.length > 0;

    if (!live) {
      return {
        configured,
        availableProviders: configuredFromEnv,
        status: configured ? "ok" : "unconfigured",
      };
    }

    try {
      const llm = await this.getLLM();
      const availableProviders = llm.getAvailableProviders();
      const detail = await llm.getHealth();
      const healthyProviders = Object.entries(detail)
        .filter(([, entry]) => entry.healthy)
        .map(([provider]) => provider);
      const unhealthyProviders = Object.entries(detail)
        .filter(([, entry]) => !entry.healthy)
        .map(([provider]) => provider);

      return {
        configured: availableProviders.length > 0,
        availableProviders,
        status: availableProviders.length === 0 ? "unconfigured" : unhealthyProviders.length > 0 ? "degraded" : "ok",
        healthyProviders,
        unhealthyProviders,
        detail,
      };
    } catch (error) {
      const providerError = error as { message?: string };
      return {
        configured,
        availableProviders: configuredFromEnv,
        status: configured ? "degraded" : "unconfigured",
        error: providerError.message ?? "provider health check failed",
      };
    }
  }

  private toGatewayResponse(
    providerResponse: ProviderResponse,
    routeClass: RouteClass,
    requestId: string,
    preferredProvider: string,
  ): LLMResponse {
    const outputText = providerResponse.message ?? providerResponse.content ?? "";

    return {
      id: providerResponse.id ?? requestId,
      provider: providerResponse.provider ?? preferredProvider,
      model: providerResponse.model,
      outputText,
      stopReason: providerResponse.finishReason,
      usage: {
        inputTokens: providerResponse.usage.inputTokens,
        outputTokens: providerResponse.usage.outputTokens,
        cachedInputTokens:
          providerResponse.usage.cachedInputTokens ?? providerResponse.usage.cacheReadInputTokens,
      },
      fallbackChain: this.consumeFallbackChain(requestId, providerResponse.provider ?? preferredProvider),
      routeClass,
      cacheHit: Boolean(
        (providerResponse.usage.cachedInputTokens ?? 0) > 0 ||
          (providerResponse.usage.cacheReadInputTokens ?? 0) > 0,
      ),
      raw: providerResponse,
    };
  }
}

let providerClient: GatewayProviderClient | null = null;

export function getProviderClient(): ProviderClient {
  if (providerClient) return providerClient;

  providerClient = new GatewayProviderClient();
  return providerClient;
}
