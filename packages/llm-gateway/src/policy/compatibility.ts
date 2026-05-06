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
    model: "qwen-3-235b",
    streaming: true,
    tools: false,
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

  const valid = defaultCompatibilityRegistry.filter((entry) => {
    if (!candidates.includes(entry.provider)) return false;
    if (needsTools && !entry.tools) return false;

    const clientSafe = client === "claude-code" ? entry.claudeCodeSafe : entry.codexSafe;
    if (clientSafe === true) return true;
    return clientSafe === "experimental" && experimentalModels;
  });

  if (valid.length > 0) return valid[0].provider;
  // Tool-capable fallback: if we need tools and nothing compatible, go to Anthropic
  if (needsTools) return "anthropic";
  // Otherwise take the first candidate
  return candidates[0] ?? "anthropic";
}
