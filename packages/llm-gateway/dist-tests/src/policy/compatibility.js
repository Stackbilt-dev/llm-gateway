export const defaultCompatibilityRegistry = [
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
        model: "gpt-5",
        streaming: true,
        tools: true,
        claudeCodeSafe: "experimental",
        codexSafe: true,
    },
    {
        provider: "groq",
        model: "llama-3.3-70b",
        streaming: true,
        tools: false,
        claudeCodeSafe: "experimental",
        codexSafe: "experimental",
    },
    {
        provider: "cerebras",
        model: "qwen3-coder-480b",
        streaming: true,
        tools: false,
        claudeCodeSafe: "experimental",
        codexSafe: "experimental",
    },
];
export function selectCompatibleProvider(candidates, request, client, experimentalModels) {
    const needsTools = Boolean(request.tools?.length);
    const valid = defaultCompatibilityRegistry.filter((entry) => {
        if (!candidates.includes(entry.provider))
            return false;
        if (needsTools && !entry.tools)
            return false;
        const clientSafe = client === "claude-code" ? entry.claudeCodeSafe : entry.codexSafe;
        if (clientSafe === true)
            return true;
        return clientSafe === "experimental" && experimentalModels;
    });
    if (valid.length > 0)
        return valid[0].provider;
    if (needsTools)
        return "anthropic";
    return candidates[0] ?? "openai";
}
