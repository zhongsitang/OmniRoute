import test from "node:test";
import assert from "node:assert/strict";

const { computeRequestHash } = await import("../../open-sse/services/requestDedup.ts");

test("computeRequestHash includes responses input", () => {
  const base = {
    model: "rayincode/gpt-5.4",
    input: "Reply with exactly OK A",
    max_output_tokens: 5,
    stream: false,
  };

  const hashA = computeRequestHash(base);
  const hashB = computeRequestHash({ ...base, input: "Reply with exactly OK B" });

  assert.notEqual(hashA, hashB);
});

test("computeRequestHash includes responses instructions and output cap", () => {
  const base = {
    model: "rayincode/gpt-5.4",
    input: "Hi",
    instructions: "Be concise",
    max_output_tokens: 5,
    stream: false,
  };

  const hashA = computeRequestHash(base);
  const hashB = computeRequestHash({ ...base, instructions: "Be verbose" });
  const hashC = computeRequestHash({ ...base, max_output_tokens: 10 });

  assert.notEqual(hashA, hashB);
  assert.notEqual(hashA, hashC);
});

test("computeRequestHash stays stable for identical responses payloads", () => {
  const body = {
    model: "rayincode/gpt-5.4",
    input: [{ role: "user", content: "Hello" }],
    max_output_tokens: 5,
    stream: false,
  };

  assert.equal(computeRequestHash(body), computeRequestHash({ ...body }));
});

test("computeRequestHash ignores object key order for equivalent responses payloads", () => {
  const bodyA = {
    model: "rayincode/gpt-5.4",
    input: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    tools: [
      {
        type: "function",
        function: {
          name: "lookup_weather",
          description: "Check the weather",
          parameters: {
            type: "object",
            properties: {
              city: { type: "string" },
              unit: { type: "string" },
            },
          },
        },
      },
    ],
    response_format: {
      json_schema: {
        name: "weather",
        schema: {
          type: "object",
          properties: {
            summary: { type: "string" },
            temperature: { type: "number" },
          },
        },
      },
      type: "json_schema",
    },
    max_output_tokens: 5,
    stream: false,
  };
  const bodyB = {
    model: "rayincode/gpt-5.4",
    input: [{ content: [{ text: "Hello", type: "text" }], role: "user" }],
    tools: [
      {
        function: {
          description: "Check the weather",
          parameters: {
            properties: {
              unit: { type: "string" },
              city: { type: "string" },
            },
            type: "object",
          },
          name: "lookup_weather",
        },
        type: "function",
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        schema: {
          properties: {
            temperature: { type: "number" },
            summary: { type: "string" },
          },
          type: "object",
        },
        name: "weather",
      },
    },
    max_output_tokens: 5,
    stream: false,
  };

  assert.equal(computeRequestHash(bodyA), computeRequestHash(bodyB));
});
