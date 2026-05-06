function estimateContentSize(input) {
    const text = input.messages.map((m) => m.content).join("\n");
    return text.length + (input.system?.length ?? 0);
}
export function classifyRequest(input) {
    const size = estimateContentSize(input);
    const hasTools = Boolean(input.tools?.length);
    const maxTokens = input.maxTokens ?? 0;
    if (hasTools)
        return "tool_heavy";
    if (size > 12000 || maxTokens > 8000)
        return "long_context";
    const userText = input.messages
        .filter((m) => m.role === "user")
        .map((m) => m.content.toLowerCase())
        .join("\n");
    if (userText.includes("architecture") || userText.includes("debug") || userText.includes("design")) {
        return "deep_reasoning";
    }
    if (size < 1500)
        return "cheap_edit";
    return "fast_code";
}
