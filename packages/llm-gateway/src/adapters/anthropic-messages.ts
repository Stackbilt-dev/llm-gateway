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

  fromLLMStream(stream: ReadableStream<string>, _context: GatewayRequestContext): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const msgId = `msg_${Date.now().toString(36)}`;

    function sse(event: string, data: unknown): Uint8Array {
      return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }

    return new ReadableStream<Uint8Array>({
      async start(controller) {
        // message_start
        controller.enqueue(sse("message_start", {
          type: "message_start",
          message: { id: msgId, type: "message", role: "assistant", content: [], model: "gateway-routed", stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
        }));
        controller.enqueue(sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
        controller.enqueue(sse("ping", { type: "ping" }));

        const reader = stream.getReader();
        let outputTokens = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              controller.enqueue(sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: value } }));
              outputTokens += Math.ceil(value.length / 4);
            }
          }
        } finally {
          reader.releaseLock();
        }

        controller.enqueue(sse("content_block_stop", { type: "content_block_stop", index: 0 }));
        controller.enqueue(sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: outputTokens } }));
        controller.enqueue(sse("message_stop", { type: "message_stop" }));
        controller.close();
      },
    });
  },
};
