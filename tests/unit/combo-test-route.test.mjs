import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-combo-test-route-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const combosDb = await import("../../src/lib/db/combos.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
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

test("combo test route short-circuits unavailable gemini-cli models before upstream probe", async () => {
  await resetStorage();

  const connection = await providersDb.createProviderConnection({
    provider: "gemini-cli",
    authType: "oauth",
    name: "Gemini CLI Active",
    email: "combo-gemini@example.com",
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    projectId: "project-123",
    providerSpecificData: { projectId: "project-123" },
    isActive: true,
    priority: 1,
  });

  await combosDb.createCombo({
    name: "combo-route-test-gemini-unavailable",
    strategy: "priority",
    models: ["gc/gemini-3.1-pro"],
  });

  const originalFetch = globalThis.fetch;
  let sawInventoryFetch = false;
  let sawUpstreamProbe = false;

  globalThis.fetch = async (url) => {
    const stringUrl = String(url);

    if (stringUrl === `http://localhost:20128/api/providers/${connection.id}/models`) {
      sawInventoryFetch = true;
      return new Response(
        JSON.stringify({
          provider: "gemini-cli",
          connectionId: connection.id,
          models: [{ id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" }],
          source: "dynamic",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    if (stringUrl.includes("/v1/")) {
      sawUpstreamProbe = true;
      return new Response(JSON.stringify({ id: "resp_test_1", output: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    throw new Error(`Unexpected fetch URL: ${stringUrl}`);
  };

  try {
    const request = new Request("http://localhost:20128/api/combos/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ comboName: "combo-route-test-gemini-unavailable", protocol: "chat" }),
    });

    const response = await comboTestRoute.POST(request);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.results[0].status, "error");
    assert.equal(payload.results[0].statusCode, 404);
    assert.match(payload.results[0].error, /not available for the current Gemini CLI account/i);
    assert.equal(sawInventoryFetch, true);
    assert.equal(sawUpstreamProbe, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("combo test route preserves gemini-cli inventory failures without upstream probe", async () => {
  await resetStorage();

  const connection = await providersDb.createProviderConnection({
    provider: "gemini-cli",
    authType: "oauth",
    name: "Gemini CLI Broken",
    email: "combo-gemini-broken@example.com",
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    projectId: "project-456",
    providerSpecificData: { projectId: "project-456" },
    isActive: true,
    priority: 1,
  });

  await combosDb.createCombo({
    name: "combo-route-test-gemini-inventory-error",
    strategy: "priority",
    models: ["gc/gemini-3.1-pro"],
  });

  const originalFetch = globalThis.fetch;
  let sawUpstreamProbe = false;

  globalThis.fetch = async (url) => {
    const stringUrl = String(url);

    if (stringUrl === `http://localhost:20128/api/providers/${connection.id}/models`) {
      return new Response(
        JSON.stringify({
          error: "Gemini CLI retrieveUserQuota failed: 500",
          source: "dynamic",
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    if (stringUrl.includes("/v1/")) {
      sawUpstreamProbe = true;
      return new Response(JSON.stringify({ id: "resp_test_1", output: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    throw new Error(`Unexpected fetch URL: ${stringUrl}`);
  };

  try {
    const request = new Request("http://localhost:20128/api/combos/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        comboName: "combo-route-test-gemini-inventory-error",
        protocol: "chat",
      }),
    });

    const response = await comboTestRoute.POST(request);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.results[0].status, "error");
    assert.equal(payload.results[0].statusCode, 500);
    assert.match(payload.results[0].error, /retrieveUserQuota failed: 500/i);
    assert.equal(sawUpstreamProbe, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("combo test route continues past a broken gemini-cli inventory when another connection supports the model", async () => {
  await resetStorage();

  const brokenConnection = await providersDb.createProviderConnection({
    provider: "gemini-cli",
    authType: "oauth",
    name: "Gemini CLI Broken First",
    email: "combo-gemini-broken-first@example.com",
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    projectId: "project-broken",
    providerSpecificData: { projectId: "project-broken" },
    isActive: true,
    priority: 1,
  });

  const healthyConnection = await providersDb.createProviderConnection({
    provider: "gemini-cli",
    authType: "oauth",
    name: "Gemini CLI Healthy Second",
    email: "combo-gemini-healthy-second@example.com",
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    projectId: "project-healthy",
    providerSpecificData: { projectId: "project-healthy" },
    isActive: true,
    priority: 2,
  });

  await combosDb.createCombo({
    name: "combo-route-test-gemini-failover",
    strategy: "priority",
    models: ["gc/gemini-2.5-pro"],
  });

  const originalFetch = globalThis.fetch;
  let sawUpstreamProbe = false;

  globalThis.fetch = async (url) => {
    const stringUrl = String(url);

    if (stringUrl === `http://localhost:20128/api/providers/${brokenConnection.id}/models`) {
      throw new Error("inventory exploded");
    }

    if (stringUrl === `http://localhost:20128/api/providers/${healthyConnection.id}/models`) {
      return new Response(
        JSON.stringify({
          provider: "gemini-cli",
          connectionId: healthyConnection.id,
          models: [{ id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" }],
          source: "dynamic",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    if (stringUrl.includes("/v1/chat/completions")) {
      sawUpstreamProbe = true;
      return new Response(
        JSON.stringify({
          id: "chatcmpl_test_1",
          object: "chat.completion",
          created: 1,
          model: "gc/gemini-2.5-pro",
          choices: [
            { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
          ],
        }),
        {
          status: 200,
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
      body: JSON.stringify({ comboName: "combo-route-test-gemini-failover", protocol: "chat" }),
    });

    const response = await comboTestRoute.POST(request);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.results[0].status, "ok");
    assert.equal(payload.resolvedBy, "gc/gemini-2.5-pro");
    assert.equal(sawUpstreamProbe, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("combo test route forwards auth headers to gemini-cli inventory requests", async () => {
  await resetStorage();

  const connection = await providersDb.createProviderConnection({
    provider: "gemini-cli",
    authType: "oauth",
    name: "Gemini CLI Auth Forward",
    email: "combo-gemini-auth@example.com",
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    projectId: "project-auth",
    providerSpecificData: { projectId: "project-auth" },
    isActive: true,
    priority: 1,
  });

  await combosDb.createCombo({
    name: "combo-route-test-gemini-auth-forward",
    strategy: "priority",
    models: ["gc/gemini-2.5-pro"],
  });

  const originalFetch = globalThis.fetch;
  let forwardedCookie = null;
  let forwardedAuthorization = null;
  let sawUpstreamProbe = false;

  globalThis.fetch = async (url, options = {}) => {
    const stringUrl = String(url);

    if (stringUrl === `http://localhost:20128/api/providers/${connection.id}/models`) {
      const headers = new Headers(options.headers);
      forwardedCookie = headers.get("cookie");
      forwardedAuthorization = headers.get("authorization");
      return new Response(
        JSON.stringify({
          provider: "gemini-cli",
          connectionId: connection.id,
          models: [{ id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" }],
          source: "dynamic",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    if (stringUrl.includes("/v1/chat/completions")) {
      sawUpstreamProbe = true;
      return new Response(
        JSON.stringify({
          id: "chatcmpl_test_auth",
          object: "chat.completion",
          created: 1,
          model: "gc/gemini-2.5-pro",
          choices: [
            { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
          ],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    throw new Error(`Unexpected fetch URL: ${stringUrl}`);
  };

  try {
    const request = new Request("http://localhost:20128/api/combos/test", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "auth_token=test-session",
        authorization: "Bearer combo-test-key",
      },
      body: JSON.stringify({
        comboName: "combo-route-test-gemini-auth-forward",
        protocol: "chat",
      }),
    });

    const response = await comboTestRoute.POST(request);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.results[0].status, "ok");
    assert.equal(sawUpstreamProbe, true);
    assert.equal(forwardedCookie, "auth_token=test-session");
    assert.equal(forwardedAuthorization, "Bearer combo-test-key");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("combo test route caches in-flight gemini-cli inventory lookups across concurrent models", async () => {
  await resetStorage();

  const connection = await providersDb.createProviderConnection({
    provider: "gemini-cli",
    authType: "oauth",
    name: "Gemini CLI Shared Inventory",
    email: "combo-gemini-shared@example.com",
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    projectId: "project-shared",
    providerSpecificData: { projectId: "project-shared" },
    isActive: true,
    priority: 1,
  });

  await combosDb.createCombo({
    name: "combo-route-test-gemini-cache",
    strategy: "priority",
    models: ["gc/gemini-3.1-pro", "gc/gemini-3.1-flash"],
  });

  const originalFetch = globalThis.fetch;
  let inventoryFetchCount = 0;
  let sawUpstreamProbe = false;

  globalThis.fetch = async (url) => {
    const stringUrl = String(url);

    if (stringUrl === `http://localhost:20128/api/providers/${connection.id}/models`) {
      inventoryFetchCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return new Response(
        JSON.stringify({
          provider: "gemini-cli",
          connectionId: connection.id,
          models: [{ id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" }],
          source: "dynamic",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    if (stringUrl.includes("/v1/")) {
      sawUpstreamProbe = true;
      return new Response(JSON.stringify({ id: "resp_test_1", output: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    throw new Error(`Unexpected fetch URL: ${stringUrl}`);
  };

  try {
    const request = new Request("http://localhost:20128/api/combos/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ comboName: "combo-route-test-gemini-cache", protocol: "chat" }),
    });

    const response = await comboTestRoute.POST(request);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.results.length, 2);
    assert.equal(
      payload.results.every((result) => result.status === "error"),
      true
    );
    assert.equal(
      payload.results.every((result) => result.statusCode === 404),
      true
    );
    assert.equal(inventoryFetchCount, 1);
    assert.equal(sawUpstreamProbe, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
