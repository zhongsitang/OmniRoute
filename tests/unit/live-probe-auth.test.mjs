import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-live-probe-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const auth = await import("../../src/sse/services/auth.ts");
const chatRoute = await import("../../src/app/api/v1/chat/completions/route.ts");

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("getProviderCredentials liveProbe does not mutate usage ordering metadata", async () => {
  await resetStorage();

  const connection = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "Live Probe Account",
    apiKey: "sk-live-probe",
    isActive: true,
    testStatus: "active",
    consecutiveUseCount: 7,
  });

  const credentials = await auth.getProviderCredentials("openai", null, null, { liveProbe: true });
  assert.equal(credentials.connectionId, connection.id);

  const updated = await providersDb.getProviderConnectionById(connection.id);
  assert.ok(updated.lastUsedAt == null);
  assert.equal(updated.consecutiveUseCount, 7);
});

test("getProviderCredentials still records usage metadata for normal requests", async () => {
  await resetStorage();
  await settingsDb.updateSettings({ fallbackStrategy: "least-used" });

  const connection = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "Normal Account",
    apiKey: "sk-normal",
    isActive: true,
    testStatus: "active",
    consecutiveUseCount: 4,
  });

  const credentials = await auth.getProviderCredentials("openai");
  assert.equal(credentials.connectionId, connection.id);

  const updated = await providersDb.getProviderConnectionById(connection.id);
  assert.equal(updated.consecutiveUseCount, 4);
  assert.ok(typeof updated.lastUsedAt === "string");
});

test("live probe chat failures do not mark the account unavailable", async () => {
  await resetStorage();

  const connection = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "Probe Failure Account",
    apiKey: "sk-live-probe-fail",
    isActive: true,
    testStatus: "active",
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json(
      {
        error: {
          message: "Invalid API key provided",
          type: "invalid_request_error",
        },
      },
      {
        status: 401,
        headers: { "content-type": "application/json" },
      }
    );

  try {
    const response = await chatRoute.POST(
      new Request("http://localhost:20128/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-omniroute-live-probe": "true",
        },
        body: JSON.stringify({
          model: "openai/gpt-4o-mini",
          messages: [{ role: "user", content: "Hi" }],
          stream: false,
        }),
      })
    );

    assert.equal(response.status, 401);

    const updated = await providersDb.getProviderConnectionById(connection.id);
    assert.equal(updated.testStatus, "active");
    assert.ok(updated.rateLimitedUntil == null);
    assert.ok(updated.lastError == null);
    assert.ok(updated.errorCode == null);
    assert.ok((updated.backoffLevel ?? 0) === 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("live probe chat failures do not try a second account", async () => {
  await resetStorage();

  await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "Probe First Account",
    apiKey: "sk-live-probe-first",
    isActive: true,
    testStatus: "active",
  });

  await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "Probe Second Account",
    apiKey: "sk-live-probe-second",
    isActive: true,
    testStatus: "active",
  });

  const originalFetch = globalThis.fetch;
  let requestCount = 0;

  globalThis.fetch = async () => {
    requestCount += 1;
    return Response.json(
      {
        error: {
          message: "First probe failed",
          type: "invalid_request_error",
        },
      },
      {
        status: 401,
        headers: { "content-type": "application/json" },
      }
    );
  };

  try {
    const response = await chatRoute.POST(
      new Request("http://localhost:20128/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-omniroute-live-probe": "true",
        },
        body: JSON.stringify({
          model: "openai/gpt-4o-mini",
          messages: [{ role: "user", content: "Hi" }],
          stream: false,
        }),
      })
    );

    const payload = await response.json();

    assert.equal(response.status, 401);
    assert.equal(requestCount, 1);
    assert.match(payload.error.message, /First probe failed/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("live probe quota failures do not trigger emergency fallback to a second model", async () => {
  await resetStorage();

  await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "Probe Billing Account",
    apiKey: "sk-live-probe-billing",
    isActive: true,
    testStatus: "active",
  });

  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  const seenBodies = [];

  globalThis.fetch = async (_url, options = {}) => {
    requestCount += 1;
    seenBodies.push(JSON.parse(String(options.body || "{}")));
    return Response.json(
      {
        error: {
          message: "Billing quota exhausted",
          type: "billing_error",
        },
      },
      {
        status: 402,
        headers: { "content-type": "application/json" },
      }
    );
  };

  try {
    const response = await chatRoute.POST(
      new Request("http://localhost:20128/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-omniroute-live-probe": "true",
        },
        body: JSON.stringify({
          model: "openai/gpt-4o-mini",
          messages: [{ role: "user", content: "Hi" }],
          stream: false,
        }),
      })
    );

    const payload = await response.json();

    assert.equal(response.status, 402);
    assert.equal(requestCount, 1);
    assert.match(seenBodies[0].model, /gpt-4o-mini/);
    assert.match(payload.error.message, /Billing quota exhausted/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
