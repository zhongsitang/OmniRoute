import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-codex-pricing-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const pricingConstants = await import("../../src/shared/constants/pricing.ts");

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("cx defaults use the current GPT-5 family pricing tiers", () => {
  const cx = pricingConstants.getDefaultPricing().cx;

  assert.deepStrictEqual(cx["gpt-5.4"], {
    input: 2.5,
    output: 15,
    cached: 0.25,
    reasoning: 15,
    cache_creation: 2.5,
  });
  assert.deepStrictEqual(cx["gpt-5.3-codex-high"], {
    input: 1.75,
    output: 14,
    cached: 0.175,
    reasoning: 14,
    cache_creation: 1.75,
  });
  assert.deepStrictEqual(cx["gpt-5.1-codex-mini-high"], {
    input: 0.25,
    output: 2,
    cached: 0.025,
    reasoning: 2,
    cache_creation: 0.25,
  });
  assert.deepStrictEqual(cx["gpt-5"], {
    input: 1.25,
    output: 10,
    cached: 0.125,
    reasoning: 10,
    cache_creation: 1.25,
  });
});

test("codex falls back to updated cx defaults when the DB has no override", async () => {
  await resetStorage();

  const gpt54 = await settingsDb.getPricingForModel("codex", "gpt-5.4");
  const gpt5 = await settingsDb.getPricingForModel("codex", "gpt-5");

  assert.deepStrictEqual(gpt54, {
    input: 2.5,
    output: 15,
    cached: 0.25,
    reasoning: 15,
    cache_creation: 2.5,
  });
  assert.deepStrictEqual(gpt5, {
    input: 1.25,
    output: 10,
    cached: 0.125,
    reasoning: 10,
    cache_creation: 1.25,
  });
});
