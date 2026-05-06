export type RouteClass =
  | "tool_loop"     // has tool_result in messages — mid-execution, needs reliable tool calling
  | "long_context"  // large context — only frontier models handle reliably
  | "planning"      // thinking/reasoning turn, tools present but not in loop
  | "code_draft"    // code generation intent, no tool loop
  | "summary"       // summarize/extract/explain — cheapest cognitive load
  | "fallback_safe"; // unknown — route to Anthropic

export type ClientProtocol =
  | "anthropic-messages"
  | "openai-responses"
  | "openai-chat";

export type ClientName = "claude-code" | "codex" | "unknown";

export interface GatewayRequestContext {
  requestId: string;
  protocol: ClientProtocol;
  client: ClientName;
  startTime: number;
  requestPath: string;
  sessionId?: string;
  repoPath?: string;
}

export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  toolCallId?: string;
}

export interface LLMTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface LLMRequest {
  model?: string;
  messages: LLMMessage[];
  system?: string;
  maxTokens?: number;
  temperature?: number;
  tools?: LLMTool[];
  toolChoice?: string | Record<string, unknown>;
  stream?: boolean;
  metadata?: Record<string, string>;
}

export interface LLMResponse {
  id: string;
  provider: string;
  model: string;
  outputText: string;
  stopReason?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
  };
  fallbackChain: string[];
  routeClass: RouteClass;
  cacheHit: boolean;
  raw?: unknown;
}

export interface ModelCompatibility {
  provider: string;
  model: string;
  streaming: boolean;
  tools: boolean;
  vision?: boolean;
  claudeCodeSafe: boolean | "experimental";
  codexSafe: boolean | "experimental";
  notes?: string;
}

export interface GatewayRequestEvent {
  id: string;
  timestamp: string;
  client: ClientName;
  protocol: ClientProtocol;
  sessionId?: string;
  repoPath?: string;
  routeClass: RouteClass;
  requestedModel?: string;
  selectedProvider: string;
  selectedModel: string;
  fallbackChain: string[];
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  costEstimateUsd?: number;
  latencyMs: number;
  cacheHit: boolean;
  status: "success" | "error" | "fallback_success";
  errorClass?: string;
  // Shadow routing fields — populated when shadowMode is on
  shadowRoute?: RouteClass;
  shadowProvider?: string;
  shadowConfidence?: "high" | "medium" | "low";
  projectedSavingsUsd?: number;
}

export interface RoutingConfig {
  default: "auto" | string;
  experimentalModels: boolean;
  shadowMode: boolean;
  routes: Record<RouteClass, string[]>;
}

export interface GatewayConfig {
  port: number;
  auth: {
    mode: "local-key" | "none";
    keys: string[];
  };
  routing: RoutingConfig;
  cache: {
    enabled: boolean;
    storage: "sqlite" | "memory";
    path: string;
    responseCache: boolean;
    prefixCache: boolean;
  };
  telemetry: {
    enabled: boolean;
    storePrompts: boolean;
    redactSecrets: boolean;
    path: string;
  };
}

export interface AdapterResult<T> {
  data: T;
  context: GatewayRequestContext;
}
