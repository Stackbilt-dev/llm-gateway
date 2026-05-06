import { textToSseStream } from "./types.js";
function normalizeInputContent(content) {
    if (typeof content === "string")
        return content;
    return content
        .filter((item) => "text" in item)
        .map((item) => ("text" in item && typeof item.text === "string" ? item.text : ""))
        .join("\n");
}
export const openAIResponsesAdapter = {
    toLLMRequest(input, _context) {
        const messages = typeof input.input === "string"
            ? [{ role: "user", content: input.input }]
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
    fromLLMResponse(output) {
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
    fromLLMStream(stream) {
        return textToSseStream("response.output_text.delta", stream);
    },
};
