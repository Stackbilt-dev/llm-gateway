import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { GatewayConfig } from "./types.js";

const defaultConfig: GatewayConfig = {
  port: 8787,
  auth: {
    mode: "local-key",
    keys: ["local-dev-key"],
  },
  routing: {
    default: "auto",
    experimentalModels: false,
    shadowMode: true, // log would-route but always route to Anthropic until validated
    routes: {
      tool_loop: ["anthropic", "openai"],        // needs real Claude for tool execution
      long_context: ["groq", "anthropic", "openai"],  // groq 128k; anthropic as fallback if key has credits
      planning: ["groq", "cerebras"],
      code_draft: ["groq", "cerebras"],
      summary: ["cerebras", "groq"],
      fallback_safe: ["groq", "cerebras"],      // never dead-end on Anthropic-only
    },
  },
  cache: {
    enabled: true,
    storage: "sqlite",
    path: ".stackbilt/gateway/cache.sqlite",
    responseCache: false,
    prefixCache: true,
  },
  telemetry: {
    enabled: true,
    storePrompts: false,
    redactSecrets: true,
    path: ".stackbilt/gateway/events.sqlite",
  },
};

function loadConfigFile(cwd: string): Partial<GatewayConfig> {
  const candidates = ["gateway.config.json", "stackbilt.gateway.json"];

  for (const file of candidates) {
    const fullPath = path.join(cwd, file);
    if (!existsSync(fullPath)) continue;
    const text = readFileSync(fullPath, "utf8");
    return JSON.parse(text) as Partial<GatewayConfig>;
  }

  return {};
}

export function resolveConfig(options?: { port?: number; cwd?: string }): GatewayConfig {
  const cwd = options?.cwd ?? process.cwd();
  const fileConfig = loadConfigFile(cwd);
  const envKey = process.env.STACKBILT_GATEWAY_KEY;

  const merged: GatewayConfig = {
    ...defaultConfig,
    ...fileConfig,
    auth: {
      ...defaultConfig.auth,
      ...fileConfig.auth,
      keys: fileConfig.auth?.keys ?? (envKey ? [envKey] : defaultConfig.auth.keys),
    },
    routing: {
      ...defaultConfig.routing,
      ...fileConfig.routing,
      routes: {
        ...defaultConfig.routing.routes,
        ...fileConfig.routing?.routes,
      },
      shadowMode: fileConfig.routing?.shadowMode ?? defaultConfig.routing.shadowMode,
    },
    cache: {
      ...defaultConfig.cache,
      ...fileConfig.cache,
    },
    telemetry: {
      ...defaultConfig.telemetry,
      ...fileConfig.telemetry,
    },
    port: options?.port ?? fileConfig.port ?? defaultConfig.port,
  };

  return merged;
}
