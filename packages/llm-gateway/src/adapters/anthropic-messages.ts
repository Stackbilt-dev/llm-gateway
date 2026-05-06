import { ClientAdapter, textToSseStream } from "./types.js";
import { GatewayRequestContext, LLMMessage, LLMRequest, LLMResponse } from "../types.js";

type AnthropicInputMessage = {
  role: "user" | "assistant";
  content: string | Array<{ type: string; text?: string }>;
};

interface AnthropicMessagesRequest {
  model?: string;
  system?: string;
  messages: AnthropicInputMessage[];
  max_tokens?: number;
  temperature?: number;
  tools?: Array<{ name: string; description?: string; input_schema?: Record<string, unknown> }>;
  tool_choice?: string | Record<string, unknown>;
  stream?: boolean;
}

interface AnthropicMessagesResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: Array<{ type: "text"; text: string }>;
  stop_reason: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

function normalizeContent(content: AnthropicInputMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

export const anthropicMessagesAdapter: ClientAdapter<AnthropicMessagesRequest, AnthropicMessagesResponse> = {
  toLLMRequest(input: AnthropicMessagesRequest, _context: GatewayRequestContext): LLMRequest {
    const messages: LLMMessage[] = input.messages.map((m) => ({
      role: m.role,
      content: normalizeContent(m.content),
    }));

    return {
      model: input.model,
      messages,
      system: input.system,
      maxTokens: input.max_tokens,
      temperature: input.temperature,
      tools: input.tools?.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.input_schema,
      })),
      toolChoice: input.tool_choice,
      stream: input.stream,
    };
  },

  fromLLMResponse(output: LLMResponse): AnthropicMessagesResponse {
    return {
      id: output.id,
      type: "message",
      role: "assistant",
      model: output.model,
      content: [{ type: "text", text: output.outputText }],
      stop_reason: output.stopReason ?? null,
      usage: output.usage
        ? {
            input_tokens: output.usage.inputTokens,
            output_tokens: output.usage.outputTokens,
            cache_read_input_tokens: output.usage.cachedInputTokens,
          }
        : undefined,
    };
  },

  fromLLMStream(stream: ReadableStream<string>): ReadableStream<Uint8Array> {
    return textToSseStream("message", stream);
  },
};
