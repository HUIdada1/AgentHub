"use strict";
// Protocol conformance fixture, not a packaged upstream implementation.
const { runStdio } = require("../../electron/backend/extensions/sdk/provider.cjs");
runStdio({ providers: [{
  id: "mock", channels: ["test-channel"],
  async listModels() { return [{ id: "test-model" }]; },
  async *invoke(request, ctx) {
    const credentials = await ctx.pool.credentials();
    const context = await ctx.pool.context();
    if (credentials.token !== "scoped-test-token" || context.region !== "test-region") throw new Error("Invalid test grant");
    yield { type: "delta", delta: { content: "你好" } };
    yield { type: "delta", delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "lookup", arguments: "{}" } }] } };
    yield { type: "usage", mode: "snapshot", usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } };
    yield { type: "finish", reason: "tool_calls" };
  },
}] });
