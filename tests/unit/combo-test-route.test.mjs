import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-combo-test-route-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const combosDb = await import("../../src/lib/db/combos.ts");
const comboTestRoute = await import("../../src/app/api/combos/test/route.ts");

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

async function runComboProbeTest(comboName, model, protocol, expected) {
  await combosDb.createCombo({
    name: comboName,
    strategy: "priority",
    models: [model],
  });

  const originalFetch = globalThis.fetch;
  let seenUrl = null;
  let seenBody = null;
  let seenHeaders = null;

  globalThis.fetch = async (url, options = {}) => {
    seenUrl = String(url);
    seenHeaders = options.headers || {};
    seenBody = JSON.parse(String(options.body || "{}"));

    return new Response(JSON.stringify({ id: "resp_test_1", output: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const request = new Request("http://localhost:20128/api/combos/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(protocol ? { comboName, protocol } : { comboName }),
    });

    const response = await comboTestRoute.POST(request);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(seenUrl, expected.url);
    assert.deepEqual(seenBody, expected.body);
    assert.equal(seenHeaders["X-Internal-Test"], "combo-health-check");
    assert.equal(seenHeaders["X-OmniRoute-No-Cache"], "true");
    assert.equal(seenHeaders["X-OmniRoute-No-Dedup"], "true");
    assert.equal(seenHeaders["X-OmniRoute-Live-Probe"], "true");
    assert.equal(payload.results[0].status, "ok");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("combo test route probes codex models via /v1/responses", async () => {
  await resetStorage();
  await runComboProbeTest("combo-route-test-codex", "codex/gpt-5.4", "responses", {
    url: "http://localhost:20128/v1/responses",
    body: {
      model: "codex/gpt-5.4",
      input: "Hi",
      max_output_tokens: 5,
      stream: false,
    },
  });
});

test("combo test route probes claude models via /v1/messages", async () => {
  await resetStorage();
  await runComboProbeTest("combo-route-test-claude", "claude/claude-sonnet-4-20250514", "claude", {
    url: "http://localhost:20128/v1/messages",
    body: {
      model: "claude/claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 5,
      stream: false,
    },
  });
});

test("combo test route probes standard chat models via /v1/chat/completions", async () => {
  await resetStorage();
  await runComboProbeTest("combo-route-test-openai", "openai/gpt-4o", "chat", {
    url: "http://localhost:20128/v1/chat/completions",
    body: {
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: "Hi" }],
      max_completion_tokens: 5,
      stream: false,
    },
  });
});

test("combo test route defaults to responses protocol when omitted", async () => {
  await resetStorage();
  await runComboProbeTest("combo-route-test-default", "codex/gpt-5.4", null, {
    url: "http://localhost:20128/v1/responses",
    body: {
      model: "codex/gpt-5.4",
      input: "Hi",
      max_output_tokens: 5,
      stream: false,
    },
  });
});
