import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-preflight-lockout-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const chatRoute = await import("../../src/app/api/v1/chat/completions/route.ts");
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

test("preflight allRateLimited quota exhaustion registers a model lockout for the requested model", async () => {
  await resetStorage();

  const resetAt = new Date(Date.now() + 45 * 60 * 1000).toISOString();
  const connection = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "Quota Exhausted Account",
    apiKey: "sk-preflight-lockout",
    isActive: true,
    testStatus: "unavailable",
    rateLimitedUntil: resetAt,
    errorCode: 429,
    lastError: '[429]: error: code=429 reason="DAILY_LIMIT_EXCEEDED" message="daily usage limit exceeded"',
  });

  const response = await chatRoute.POST(
    new Request("http://localhost:20128/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "openai/gpt-4o-mini",
        messages: [{ role: "user", content: "Hi" }],
        stream: false,
      }),
    })
  );

  assert.equal(response.status, 429);

  const lockout = accountFallback.getModelLockoutInfo("openai", connection.id, "gpt-4o-mini");
  assert.ok(lockout);
  assert.equal(lockout.reason, "quota_exhausted");
  assert.ok(lockout.remainingMs > 44 * 60 * 1000);
});
