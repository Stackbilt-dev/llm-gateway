import { textToSseStream } from "./types.js";
export const openAIChatCompletionsAdapter = {
    toLLMRequest(input, _context) {
        return {
            model: input.model,
            messages: input.messages.map((m) => ({
                role: m.role,
                content: m.content,
                name: m.name,
                toolCallId: m.tool_call_id,
            })),
            maxTokens: input.max_tokens,
            temperature: input.temperature,
            tools: input.tools?.map((tool) => ({
                name: tool.function?.name ?? "unnamed_tool",
                description: tool.function?.description,
                inputSchema: tool.function?.parameters,
            })),
            toolChoice: input.tool_choice,
            stream: input.stream,
        };
    },
    fromLLMResponse(output) {
        const promptTokens = output.usage?.inputTokens;
        const completionTokens = output.usage?.outputTokens;
        return {
            id: output.id,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: output.model,
            choices: [
                {
                    index: 0,
                    finish_reason: output.stopReason ?? "stop",
                    message: {
                        role: "assistant",
                        content: output.outputText,
                    },
                },
            ],
            usage: promptTokens !== undefined || completionTokens !== undefined
                ? {
                    prompt_tokens: promptTokens,
                    completion_tokens: completionTokens,
                    total_tokens: (promptTokens ?? 0) + (completionTokens ?? 0),
                }
                : undefined,
        };
    },
    fromLLMStream(stream) {
        return textToSseStream("chat.completion.chunk", stream);
    },
};
