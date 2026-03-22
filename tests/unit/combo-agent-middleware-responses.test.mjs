import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { applyComboAgentMiddleware } from "../../open-sse/services/comboAgentMiddleware.ts";
import { handleComboChat } from "../../open-sse/services/combo.ts";

describe("comboAgentMiddleware — responses compatibility", () => {
  it("keeps Responses requests in Responses shape and strips top-level messages", () => {
    const body = {
      model: "gpt-5.4",
      input: [{ role: "user", content: [{ type: "input_text", text: "Reply with OK only." }] }],
      instructions: "old instructions",
      messages: [{ role: "user", content: "should not reach provider" }],
      tools: [
        { type: "function", function: { name: "keep_tool" } },
        { type: "function", function: { name: "drop_tool" } },
      ],
    };
    const combo = {
      system_message: "combo instructions",
      tool_filter_regex: "^keep_",
    };

    const result = applyComboAgentMiddleware(body, combo, "");

    assert.ok(!("messages" in result.body), "Responses requests must not leak messages");
    assert.equal(result.body.instructions, "combo instructions");
    assert.deepEqual(result.body.input, body.input);
    assert.deepEqual(result.body.tools, [{ type: "function", function: { name: "keep_tool" } }]);
  });

  it("preserves chat-style messages behavior for non-Responses requests", () => {
    const body = {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
    };
    const combo = {
      system_message: "combo system",
    };

    const result = applyComboAgentMiddleware(body, combo, "");

    assert.deepEqual(result.body.messages, [
      { role: "system", content: "combo system" },
      { role: "user", content: "hello" },
    ]);
  });

  it("passes sanitized Responses bodies through combo routing without messages", async () => {
    let forwardedBody = null;

    const result = await handleComboChat({
      body: {
        model: "gpt-5.4",
        input: [{ role: "user", content: [{ type: "input_text", text: "Reply with OK only." }] }],
        instructions: "old instructions",
        messages: [{ role: "user", content: "should not reach provider" }],
      },
      combo: {
        name: "gpt-5.4",
        strategy: "priority",
        models: [{ model: "cx/gpt-5.4", weight: 0 }],
        system_message: "combo instructions",
      },
      handleSingleModel: async (body, modelStr) => {
        forwardedBody = body;
        assert.equal(modelStr, "cx/gpt-5.4");
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
      isModelAvailable: async () => true,
      log: {
        info() {},
        warn() {},
        error() {},
      },
      settings: null,
      allCombos: null,
    });

    assert.equal(result.status, 200);
    assert.ok(forwardedBody, "combo should forward a body to the selected model");
    assert.ok(!("messages" in forwardedBody), "combo forwarded body must not include messages");
    assert.equal(forwardedBody.instructions, "combo instructions");
    assert.deepEqual(forwardedBody.input, [
      { role: "user", content: [{ type: "input_text", text: "Reply with OK only." }] },
    ]);
  });
});
