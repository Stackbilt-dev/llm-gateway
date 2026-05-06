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

      this.llm = providersModule.LLMProviders.fromEnv(process.env as Record<string, unknown>, {
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
    if (preferredProviderName && (cheapProviders.has(preferredProviderName) || !providerRequest.model)) {
      const providersModule = await loadProvidersModule();
      providerRequest.model = providersModule.getProviderDefaultModel(preferredProviderName, providerRequest);
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
