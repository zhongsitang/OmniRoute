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
    const stringUrl = String(url);
    if (stringUrl.includes("/api/providers/")) {
      throw new Error(`Unexpected inventory fetch: ${stringUrl}`);
    }

    seenUrl = stringUrl;
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
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Hi" }],
        },
      ],
      instructions: "Reply briefly.",
      store: false,
      stream: true,
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
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Hi" }],
        },
      ],
      instructions: "Reply briefly.",
      store: false,
      stream: true,
    },
  });
});

test("combo test route probes gemini-cli models through the standard probe path", async () => {
  await resetStorage();
  await runComboProbeTest("combo-route-test-gemini-standard", "gc/gemini-2.5-pro", "chat", {
    url: "http://localhost:20128/v1/chat/completions",
    body: {
      model: "gc/gemini-2.5-pro",
      messages: [{ role: "user", content: "Hi" }],
      max_completion_tokens: 5,
      stream: false,
    },
  });
});

test("combo test route surfaces upstream gemini-cli probe errors directly", async () => {
  await resetStorage();

  await combosDb.createCombo({
    name: "combo-route-test-gemini-upstream-error",
    strategy: "priority",
    models: ["gc/gemini-3.1-pro"],
  });

  const originalFetch = globalThis.fetch;
  let sawProbeCount = 0;

  globalThis.fetch = async (url) => {
    const stringUrl = String(url);
    if (stringUrl.includes("/api/providers/")) {
      throw new Error(`Unexpected inventory fetch: ${stringUrl}`);
    }
    if (stringUrl === "http://localhost:20128/v1/chat/completions") {
      sawProbeCount += 1;
      return new Response(
        JSON.stringify({
          error: {
            message: "Gemini upstream 404",
          },
        }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    throw new Error(`Unexpected fetch URL: ${stringUrl}`);
  };

  try {
    const request = new Request("http://localhost:20128/api/combos/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        comboName: "combo-route-test-gemini-upstream-error",
        protocol: "chat",
      }),
    });

    const response = await comboTestRoute.POST(request);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(sawProbeCount, 1);
    assert.equal(payload.results[0].status, "error");
    assert.equal(payload.results[0].statusCode, 404);
    assert.equal(payload.results[0].error, "Gemini upstream 404");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("combo test route times out a stalled standard probe", async () => {
  await resetStorage();

  await combosDb.createCombo({
    name: "combo-route-test-timeout",
    strategy: "priority",
    models: ["gc/gemini-2.5-pro"],
  });

  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;

  globalThis.setTimeout = (callback, _delay, ...args) => originalSetTimeout(callback, 0, ...args);
  globalThis.clearTimeout = (timeoutId) => originalClearTimeout(timeoutId);

  globalThis.fetch = async (url, options = {}) => {
    const stringUrl = String(url);
    if (stringUrl.includes("/api/providers/")) {
      throw new Error(`Unexpected inventory fetch: ${stringUrl}`);
    }
    if (stringUrl === "http://localhost:20128/v1/chat/completions") {
      return await new Promise((resolve, reject) => {
        if (options.signal.aborted) {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
          return;
        }

        options.signal.addEventListener(
          "abort",
          () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          },
          { once: true }
        );
      });
    }

    throw new Error(`Unexpected fetch URL: ${stringUrl}`);
  };

  try {
    const request = new Request("http://localhost:20128/api/combos/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ comboName: "combo-route-test-timeout", protocol: "chat" }),
    });

    const response = await comboTestRoute.POST(request);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.results[0].status, "error");
    assert.equal(payload.results[0].error, "Timeout (20s)");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test("combo test route cancels an in-flight standard probe when the parent request aborts", async () => {
  await resetStorage();

  await combosDb.createCombo({
    name: "combo-route-test-abort",
    strategy: "priority",
    models: ["gc/gemini-2.5-pro"],
  });

  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let sawProbeCount = 0;
  let timeoutCallbackRuns = 0;

  globalThis.fetch = async (url, options = {}) => {
    const stringUrl = String(url);
    if (stringUrl.includes("/api/providers/")) {
      throw new Error(`Unexpected inventory fetch: ${stringUrl}`);
    }
    if (stringUrl === "http://localhost:20128/v1/chat/completions") {
      sawProbeCount += 1;
      return await new Promise((resolve, reject) => {
        if (options.signal.aborted) {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
          return;
        }

        options.signal.addEventListener(
          "abort",
          () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          },
          { once: true }
        );
      });
    }

    throw new Error(`Unexpected fetch URL: ${stringUrl}`);
  };

  globalThis.setTimeout = (_callback, _delay, ..._args) => ({ fake: true });
  globalThis.clearTimeout = () => {};

  try {
    const requestController = new AbortController();
    requestController.abort();
    const request = {
      url: "http://localhost:20128/api/combos/test",
      headers: new Headers({ "content-type": "application/json" }),
      signal: requestController.signal,
      json: async () => ({ comboName: "combo-route-test-abort", protocol: "chat" }),
    };

    const responsePromise = comboTestRoute.POST(request);
    const timeoutSentinel = Symbol("timeout");
    const raced = await Promise.race([
      responsePromise,
      new Promise((resolve) => originalSetTimeout(() => resolve(timeoutSentinel), 100)),
    ]);

    assert.notEqual(raced, timeoutSentinel, "probe should finish without waiting for timeout");

    const response = raced;
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(sawProbeCount, 1);
    assert.equal(timeoutCallbackRuns, 0);
    assert.deepEqual(payload.results, []);
    assert.equal(payload.resolvedBy, null);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});
