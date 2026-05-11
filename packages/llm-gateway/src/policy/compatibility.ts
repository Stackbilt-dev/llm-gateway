import { ClientName, LLMRequest, ModelCompatibility } from "../types.js";

export const defaultCompatibilityRegistry: ModelCompatibility[] = [
  {
    provider: "anthropic",
    model: "claude-sonnet-4",
    streaming: true,
    tools: true,
    claudeCodeSafe: true,
    codexSafe: "experimental",
  },
  {
    provider: "openai",
    model: "gpt-4o",
    streaming: true,
    tools: true,
    claudeCodeSafe: "experimental",
    codexSafe: true,
  },
  {
    provider: "groq",
    model: "llama-3.3-70b-versatile",
    streaming: true,
    tools: true, // Groq supports function calling on versatile
    claudeCodeSafe: "experimental",
    codexSafe: "experimental",
  },
  {
    provider: "cerebras",
    model: "qwen-3-235b-a22b-instruct-2507",
    streaming: true,
    tools: true,
    claudeCodeSafe: "experimental",
    codexSafe: "experimental",
  },
  {
    provider: "cloudflare",
    model: "qwen2.5-coder-32b",
    streaming: true,
    tools: false,
    claudeCodeSafe: "experimental",
    codexSafe: "experimental",
  },
];

export function selectCompatibleProvider(
  candidates: string[],
  request: LLMRequest,
  client: ClientName,
  experimentalModels: boolean,
): string {
  const needsTools = Boolean(request.tools?.length);

  // Walk candidates in the order specified by the route config — first compatible wins.
  // This ensures the gateway respects preferred provider ordering (e.g. groq before anthropic).
  for (const candidate of candidates) {
    const entry = defaultCompatibilityRegistry.find((e) => e.provider === candidate);
    if (!entry) continue;
    if (needsTools && !entry.tools) continue;

    const clientSafe = client === "claude-code" ? entry.claudeCodeSafe : entry.codexSafe;
    if (clientSafe === true || (clientSafe === "experimental" && experimentalModels)) {
      return candidate;
    }
  }

  // Fallback: if experimentalModels=false filtered everything out, accept experimental providers
  for (const candidate of candidates) {
    const entry = defaultCompatibilityRegistry.find((e) => e.provider === candidate);
    if (!entry) continue;
    if (needsTools && !entry.tools) continue;
    return candidate;
  }

  // Last resort
  if (needsTools) return "anthropic";
  return candidates[0] ?? "anthropic";
}
