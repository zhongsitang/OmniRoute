import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-provider-models-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.NEXT_PHASE = "phase-production-build";
process.env.JWT_SECRET = "x".repeat(32);
process.env.API_KEY_SECRET = "y".repeat(32);

const core = await import("../../src/lib/db/core.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const modelsDb = await import("../../src/lib/db/models.ts");
const dbState = await import("../../src/lib/db/stateReset.ts");
const providerModelsRoute = await import("../../src/app/api/provider-models/route.ts");

async function resetStorage() {
  core.resetDbInstance();
  dbState.resetAllDbModuleState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

async function createAuthHeaders() {
  const apiKey = await apiKeysDb.createApiKey(
    "provider-models-test-key",
    "machine-provider-models"
  );
  return {
    authorization: `Bearer ${apiKey.key}`,
    "content-type": "application/json",
  };
}

function buildPostRequest(body, headers) {
  return new Request("http://localhost/api/provider-models", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  core.resetDbInstance();
  dbState.resetAllDbModuleState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("getCustomModels normalizes legacy object-shaped customModels rows", async () => {
  const db = core.getDbInstance();
  db.prepare(
    "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('customModels', ?, ?)"
  ).run(
    "openai-compatible-legacy-node",
    JSON.stringify({
      "legacy-model": {
        name: "Legacy Model",
        source: "imported",
      },
    })
  );

  const stored = await modelsDb.getCustomModels("openai-compatible-legacy-node");
  assert.equal(stored.length, 1);
  assert.equal(stored[0].id, "legacy-model");
  assert.equal(stored[0].name, "Legacy Model");
  assert.equal(stored[0].source, "imported");
  assert.equal(stored[0].apiFormat, "chat-completions");
  assert.deepEqual(stored[0].supportedEndpoints, ["chat"]);
});

test("provider-models POST keeps working when a provider has legacy object-shaped customModels rows", async () => {
  const headers = await createAuthHeaders();
  const db = core.getDbInstance();
  db.prepare(
    "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('customModels', ?, ?)"
  ).run(
    "openai-compatible-legacy-node",
    JSON.stringify({
      "legacy-model": {
        name: "Legacy Model",
        source: "imported",
      },
    })
  );

  const response = await providerModelsRoute.POST(
    buildPostRequest(
      {
        provider: "openai-compatible-legacy-node",
        modelId: "gpt-new",
        modelName: "GPT New",
        source: "imported",
      },
      headers
    )
  );

  assert.equal(response.status, 200);
  const stored = await modelsDb.getCustomModels("openai-compatible-legacy-node");
  assert.equal(stored.length, 2);
  assert.ok(stored.some((model) => model.id === "legacy-model" && model.name === "Legacy Model"));
  assert.ok(stored.some((model) => model.id === "gpt-new" && model.name === "GPT New"));
});
