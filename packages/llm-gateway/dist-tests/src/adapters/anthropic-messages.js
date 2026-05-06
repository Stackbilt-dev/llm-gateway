import { textToSseStream } from "./types.js";
function normalizeContent(content) {
    if (typeof content === "string")
        return content;
    return content
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("\n");
}
export const anthropicMessagesAdapter = {
    toLLMRequest(input, _context) {
        const messages = input.messages.map((m) => ({
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
    fromLLMResponse(output) {
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
    fromLLMStream(stream) {
        return textToSseStream("message", stream);
    },
};
