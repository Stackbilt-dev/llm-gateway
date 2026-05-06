import { ClientAdapter, textToSseStream } from "./types.js";
import { GatewayRequestContext, LLMRequest, LLMResponse } from "../types.js";

interface OpenAIResponseInput {
  role: "user" | "assistant" | "system";
  content:
    | string
    | Array<
        | { type: "input_text"; text: string }
        | { type: "output_text"; text: string }
        | { type: string; [key: string]: unknown }
      >;
}

interface OpenAIResponsesRequest {
  model?: string;
  input?: string | OpenAIResponseInput[];
  max_output_tokens?: number;
  temperature?: number;
  tools?: Array<{ type?: string; name?: string; description?: string; parameters?: Record<string, unknown> }>;
  tool_choice?: string | Record<string, unknown>;
  stream?: boolean;
}

interface OpenAIResponsesResponse {
  id: string;
  object: "response";
  model: string;
  output: Array<{
    id: string;
    type: "message";
    role: "assistant";
    content: Array<{ type: "output_text"; text: string }>;
  }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

function normalizeInputContent(content: OpenAIResponseInput["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((item) => "text" in item)
    .map((item) => ("text" in item && typeof item.text === "string" ? item.text : ""))
    .join("\n");
}

export const openAIResponsesAdapter: ClientAdapter<OpenAIResponsesRequest, OpenAIResponsesResponse> = {
  toLLMRequest(input: OpenAIResponsesRequest, _context: GatewayRequestContext): LLMRequest {
    const messages =
      typeof input.input === "string"
        ? [{ role: "user" as const, content: input.input }]
        : (input.input ?? []).map((m) => ({
            role: m.role,
            content: normalizeInputContent(m.content),
          }));

    return {
      model: input.model,
      messages,
      maxTokens: input.max_output_tokens,
      temperature: input.temperature,
      tools: input.tools?.map((tool) => ({
        name: tool.name ?? "unnamed_tool",
        description: tool.description,
        inputSchema: tool.parameters,
      })),
      toolChoice: input.tool_choice,
      stream: input.stream,
    };
  },

  fromLLMResponse(output: LLMResponse): OpenAIResponsesResponse {
    return {
      id: output.id,
      object: "response",
      model: output.model,
      output: [
        {
          id: `${output.id}_msg`,
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: output.outputText }],
        },
      ],
      usage: output.usage
        ? {
            input_tokens: output.usage.inputTokens,
            output_tokens: output.usage.outputTokens,
          }
        : undefined,
    };
  },

  fromLLMStream(stream: ReadableStream<string>): ReadableStream<Uint8Array> {
    return textToSseStream("response.output_text.delta", stream);
  },
};
