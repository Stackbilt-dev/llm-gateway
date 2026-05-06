import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
const defaultConfig = {
    port: 8787,
    auth: {
        mode: "local-key",
        keys: ["local-dev-key"],
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
function loadConfigFile(cwd) {
    const candidates = ["gateway.config.json", "stackbilt.gateway.json"];
    for (const file of candidates) {
        const fullPath = path.join(cwd, file);
        if (!existsSync(fullPath))
            continue;
        const text = readFileSync(fullPath, "utf8");
        return JSON.parse(text);
    }
    return {};
}
export function resolveConfig(options) {
    const cwd = options?.cwd ?? process.cwd();
    const fileConfig = loadConfigFile(cwd);
    const envKey = process.env.STACKBILT_GATEWAY_KEY;
    const merged = {
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
