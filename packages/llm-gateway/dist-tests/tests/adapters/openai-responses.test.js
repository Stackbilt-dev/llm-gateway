import assert from "node:assert/strict";
import test from "node:test";
import { openAIResponsesAdapter } from "../../src/adapters/openai-responses.js";
const context = {
    requestId: "req-2",
    protocol: "openai-responses",
    client: "codex",
    startTime: Date.now(),
    requestPath: "/v1/responses",
};
test("openai responses adapter accepts string input", () => {
    const req = openAIResponsesAdapter.toLLMRequest({
        model: "gpt-5",
        input: "explain this function",
        max_output_tokens: 256,
        temperature: 0.1,
        stream: false,
    }, context);
    assert.equal(req.messages.length, 1);
    assert.equal(req.messages[0].role, "user");
    assert.equal(req.messages[0].content, "explain this function");
    assert.equal(req.maxTokens, 256);
});
test("openai responses adapter renders output payload", () => {
    const llmResponse = {
        id: "resp-1",
        provider: "openai",
        model: "gpt-5",
        outputText: "summary",
        usage: {
            inputTokens: 12,
            outputTokens: 7,
        },
        fallbackChain: ["openai"],
        routeClass: "deep_reasoning",
        cacheHit: false,
    };
    const out = openAIResponsesAdapter.fromLLMResponse(llmResponse, context);
    assert.equal(out.object, "response");
    assert.equal(out.output[0].content[0].text, "summary");
    assert.equal(out.usage?.output_tokens, 7);
});
