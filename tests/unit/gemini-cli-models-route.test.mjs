import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-gemini-cli-models-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const modelsRoute = await import("../../src/app/api/providers/[id]/models/route.ts");

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("gemini-cli models route preserves quota discovery failures as errors", async () => {
  await resetStorage();

  const connection = await providersDb.createProviderConnection({
    provider: "gemini-cli",
    authType: "oauth",
    name: "Gemini CLI Test",
    email: "gemini-cli@example.com",
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    projectId: "project-123",
    providerSpecificData: { projectId: "project-123" },
    isActive: true,
    priority: 1,
  });

  const originalFetch = globalThis.fetch;
  const seenUrls = [];

  globalThis.fetch = async (url) => {
    const stringUrl = String(url);
    seenUrls.push(stringUrl);

    if (stringUrl.includes("retrieveUserQuota")) {
      return new Response(JSON.stringify({ error: { message: "quota unavailable" } }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const request = new Request(`http://localhost:20128/api/providers/${connection.id}/models`);
    const response = await modelsRoute.GET(request, {
      params: Promise.resolve({ id: connection.id }),
    });
    const payload = await response.json();

    assert.equal(response.status, 500);
    assert.equal(payload.source, "dynamic");
    assert.match(payload.error, /retrieveUserQuota failed/i);
    assert.match(payload.error, /quota unavailable/i);
    assert.ok(
      seenUrls.some((url) => url.includes("retrieveUserQuota")),
      "Should attempt dynamic Gemini CLI quota discovery"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("gemini-cli models route returns empty models only when dynamic discovery succeeds with none", async () => {
  await resetStorage();

  const connection = await providersDb.createProviderConnection({
    provider: "gemini-cli",
    authType: "oauth",
    name: "Gemini CLI Empty Models",
    email: "gemini-cli-empty@example.com",
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    projectId: "project-456",
    providerSpecificData: { projectId: "project-456" },
    isActive: true,
    priority: 1,
  });

  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url) => {
    const stringUrl = String(url);

    if (stringUrl.includes("retrieveUserQuota")) {
      return new Response(JSON.stringify({ buckets: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const request = new Request(`http://localhost:20128/api/providers/${connection.id}/models`);
    const response = await modelsRoute.GET(request, {
      params: Promise.resolve({ id: connection.id }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.provider, "gemini-cli");
    assert.equal(payload.connectionId, connection.id);
    assert.deepEqual(payload.models, []);
    assert.equal(payload.source, "dynamic");
    assert.match(payload.warning, /no account-available models/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
