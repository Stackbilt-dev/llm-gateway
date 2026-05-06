import assert from "node:assert/strict";
import test from "node:test";
import { classifyRequest } from "../../src/policy/classify.js";
test("classifies tool requests as tool_heavy", () => {
    const route = classifyRequest({
        messages: [{ role: "user", content: "Use tools" }],
        tools: [{ name: "lookup" }],
    });
    assert.equal(route, "tool_heavy");
});
test("classifies large payload as long_context", () => {
    const route = classifyRequest({
        messages: [{ role: "user", content: "x".repeat(13000) }],
    });
    assert.equal(route, "long_context");
});
test("classifies short requests as cheap_edit", () => {
    const route = classifyRequest({
        messages: [{ role: "user", content: "fix typo" }],
    });
    assert.equal(route, "cheap_edit");
});
