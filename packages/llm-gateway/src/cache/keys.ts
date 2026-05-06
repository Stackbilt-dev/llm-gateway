import { LLMRequest } from "../types.js";

export function buildPrefixCacheKey(request: LLMRequest): string {
  const system = request.system ?? "";
  const tools = JSON.stringify(request.tools ?? []);
  const firstUser = request.messages.find((m) => m.role === "user")?.content.slice(0, 250) ?? "";
  return `prefix:${system}:${tools}:${firstUser}`;
}

export function buildResponseCacheKey(request: LLMRequest): string {
  const payload = JSON.stringify({
    model: request.model,
    messages: request.messages,
    maxTokens: request.maxTokens,
    temperature: request.temperature,
  });

  let hash = 0;
  for (let i = 0; i < payload.length; i += 1) {
    hash = (hash << 5) - hash + payload.charCodeAt(i);
    hash |= 0;
  }
  return `response:${Math.abs(hash)}`;
}
