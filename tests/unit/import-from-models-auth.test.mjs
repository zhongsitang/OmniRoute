import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-import-auth-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.NEXT_PHASE = "phase-production-build";
process.env.JWT_SECRET = "x".repeat(32);
process.env.API_KEY_SECRET = "y".repeat(32);

const core = await import("../../src/lib/db/core.ts");
const dbState = await import("../../src/lib/db/stateReset.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const providerModelsRoute = await import("../../src/app/api/provider-models/route.ts");
const modelAliasesRoute = await import("../../src/app/api/models/alias/route.ts");
const modelsDb = await import("../../src/lib/db/models.ts");

const originalInitialPassword = process.env.INITIAL_PASSWORD;

async function resetStorage() {
  core.resetDbInstance();
  dbState.resetAllDbModuleState();
}

test.beforeEach(async () => {
  await resetStorage();
  delete process.env.INITIAL_PASSWORD;
});

test.after(async () => {
  await resetStorage();
  if (originalInitialPassword === undefined) {
    delete process.env.INITIAL_PASSWORD;
  } else {
    process.env.INITIAL_PASSWORD = originalInitialPassword;
  }
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("Import from /models management routes allow dashboard access when requireLogin is false", async () => {
  await settingsDb.updateSettings({ requireLogin: false });

  const providerId = "openai-compatible-responses-test-node";
  const modelId = "import-flow-probe";
  const alias = "probe-import-flow-probe";

  const addResponse = await providerModelsRoute.POST(
    new Request("http://localhost/api/provider-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: providerId,
        modelId,
        modelName: "Import Flow Probe",
        source: "imported",
      }),
    })
  );
  assert.equal(addResponse.status, 200);

  const aliasResponse = await modelAliasesRoute.PUT(
    new Request("http://localhost/api/models/alias", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `${providerId}/${modelId}`,
        alias,
      }),
    })
  );
  assert.equal(aliasResponse.status, 200);

  const listModelsResponse = await providerModelsRoute.GET(
    new Request(`http://localhost/api/provider-models?provider=${encodeURIComponent(providerId)}`)
  );
  assert.equal(listModelsResponse.status, 200);
  const listModelsPayload = await listModelsResponse.json();
  assert.ok(listModelsPayload.models.some((model) => model.id === modelId));

  const aliasesResponse = await modelAliasesRoute.GET(
    new Request("http://localhost/api/models/alias")
  );
  assert.equal(aliasesResponse.status, 200);
  const aliasesPayload = await aliasesResponse.json();
  assert.equal(aliasesPayload.aliases[alias], `${providerId}/${modelId}`);

  const removeModelResponse = await providerModelsRoute.DELETE(
    new Request(
      `http://localhost/api/provider-models?provider=${encodeURIComponent(providerId)}&model=${encodeURIComponent(modelId)}`,
      { method: "DELETE" }
    )
  );
  assert.equal(removeModelResponse.status, 200);

  const deleteAliasResponse = await modelAliasesRoute.DELETE(
    new Request(`http://localhost/api/models/alias?alias=${encodeURIComponent(alias)}`, {
      method: "DELETE",
    })
  );
  assert.equal(deleteAliasResponse.status, 200);

  const storedModels = await modelsDb.getCustomModels(providerId);
  assert.equal(storedModels.length, 0);
});

test("Import from /models management routes still require auth when login protection is enabled", async () => {
  process.env.INITIAL_PASSWORD = "CHANGEME";
  await settingsDb.updateSettings({ requireLogin: true });

  const providerResponse = await providerModelsRoute.POST(
    new Request("http://localhost/api/provider-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "openai-compatible-responses-test-node",
        modelId: "blocked-probe",
        modelName: "Blocked Probe",
      }),
    })
  );
  assert.equal(providerResponse.status, 401);

  const aliasResponse = await modelAliasesRoute.PUT(
    new Request("http://localhost/api/models/alias", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openai-compatible-responses-test-node/blocked-probe",
        alias: "blocked-probe",
      }),
    })
  );
  assert.equal(aliasResponse.status, 401);
});
