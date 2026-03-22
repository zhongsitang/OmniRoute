import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-quota-reset-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const auth = await import("../../src/sse/services/auth.ts");
const quotaCache = await import("../../src/domain/quotaCache.ts");
const accountFallback = await import("../../open-sse/services/accountFallback.ts");

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("markAccountUnavailable locks quota-exhausted accounts until exact provider reset", async () => {
  await resetStorage();

  const connection = await providersDb.createProviderConnection({
    provider: "openai-compatible-responses-reset-test-node",
    authType: "apikey",
    name: "Reset Test",
    apiKey: "sk-reset",
    isActive: true,
    providerSpecificData: {
      baseUrl: "https://reset.example/v1",
    },
  });

  const resetAt = new Date(Date.now() + 45 * 60 * 1000).toISOString();
  quotaCache.markAccountExhaustedFrom429(connection.id, connection.provider, resetAt);

  const result = await auth.markAccountUnavailable(
    connection.id,
    429,
    'error: code=429 reason="DAILY_LIMIT_EXCEEDED" message="daily usage limit exceeded"',
    connection.provider,
    "gpt-5.4"
  );

  assert.equal(result.shouldFallback, true);
  assert.ok(result.cooldownMs > 44 * 60 * 1000);
  assert.ok(result.cooldownMs <= 45 * 60 * 1000);

  const updated = await providersDb.getProviderConnectionById(connection.id);
  assert.equal(updated.testStatus, "unavailable");
  assert.match(String(updated.errorCode), /^429/);
  assert.equal(updated.backoffLevel, 1);
  assert.equal(updated.rateLimitedUntil, resetAt);

  const lockout = accountFallback.getModelLockoutInfo(
    connection.provider,
    connection.id,
    "gpt-5.4"
  );
  assert.ok(lockout);
  assert.equal(lockout.reason, "quota_exhausted");
  assert.ok(lockout.remainingMs > 44 * 60 * 1000);
});

test("markAccountUnavailable also honors exact reset for non-429 quota exhaustion", async () => {
  await resetStorage();

  const connection = await providersDb.createProviderConnection({
    provider: "openai-compatible-responses-reset-test-node-402",
    authType: "apikey",
    name: "Reset Test 402",
    apiKey: "sk-reset-402",
    isActive: true,
    providerSpecificData: {
      baseUrl: "https://reset.example/v1",
    },
  });

  const resetAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  quotaCache.markAccountExhaustedFrom429(connection.id, connection.provider, resetAt);

  const result = await auth.markAccountUnavailable(
    connection.id,
    402,
    "billing hard limit reached",
    connection.provider,
    "gpt-5.4"
  );

  assert.equal(result.shouldFallback, true);
  assert.ok(result.cooldownMs > 29 * 60 * 1000);
  assert.ok(result.cooldownMs <= 30 * 60 * 1000);

  const updated = await providersDb.getProviderConnectionById(connection.id);
  assert.equal(updated.testStatus, "unavailable");
  assert.match(String(updated.errorCode), /^402/);
  assert.equal(updated.backoffLevel, 1);
  assert.equal(updated.rateLimitedUntil, resetAt);

  const lockout = accountFallback.getModelLockoutInfo(
    connection.provider,
    connection.id,
    "gpt-5.4"
  );
  assert.ok(lockout);
  assert.equal(lockout.reason, "quota_exhausted");
  assert.ok(lockout.remainingMs > 29 * 60 * 1000);
});
