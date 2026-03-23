import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-monitoring-health-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const combosDb = await import("../../src/lib/db/combos.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const healthRoute = await import("../../src/app/api/monitoring/health/route.ts");
const circuitBreaker = await import("../../src/shared/utils/circuitBreaker.ts");
const localHealthCheck = await import("../../src/lib/localHealthCheck.ts");

async function resetStorage() {
  localHealthCheck.stopLocalHealthCheck();
  circuitBreaker.resetAllCircuitBreakers();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.after(() => {
  localHealthCheck.stopLocalHealthCheck();
  circuitBreaker.resetAllCircuitBreakers();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("monitoring health route filters stale provider and combo breakers", async () => {
  await resetStorage();

  await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "OpenAI Test",
    apiKey: "sk-health-test",
    isActive: true,
  });

  await combosDb.createCombo({
    name: "active-health-combo",
    strategy: "priority",
    models: ["openai/gpt-4o"],
  });

  circuitBreaker.getCircuitBreaker("openai");
  circuitBreaker.getCircuitBreaker("combo:openai/gpt-4o");
  circuitBreaker.getCircuitBreaker("anthropic");
  circuitBreaker.getCircuitBreaker("combo:openai/gpt-4.1");

  const response = await healthRoute.GET();
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.ok(payload.providerHealth.openai);
  assert.ok(payload.providerHealth["combo:openai/gpt-4o"]);
  assert.equal(payload.providerHealth.anthropic, undefined);
  assert.equal(payload.providerHealth["combo:openai/gpt-4.1"], undefined);
});
