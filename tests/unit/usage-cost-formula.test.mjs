import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-usage-cost-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const { calculateCost } = await import("../../src/lib/usage/costCalculator.ts");
const { normalizeUsageToCostTokens } = await import("../../src/lib/usage/costTracking.ts");

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("calculateCost does not double-charge cache creation tokens", async () => {
  await resetStorage();
  await settingsDb.updatePricing({
    "unit-test-provider": {
      "unit-test-model": {
        input: 2,
        cached: 0.5,
        output: 10,
        reasoning: 10,
        cache_creation: 3,
      },
    },
  });

  const cost = await calculateCost("unit-test-provider", "unit-test-model", {
    input: 1_000,
    output: 50,
    cacheRead: 600,
    cacheCreation: 200,
    reasoning: 20,
  });

  assert.equal(cost, 0.0018);
});

test("normalizeUsageToCostTokens keeps OpenAI prompt totals inclusive", () => {
  const tokens = normalizeUsageToCostTokens({
    prompt_tokens: 1_000,
    completion_tokens: 50,
    prompt_tokens_details: {
      cached_tokens: 600,
      cache_creation_tokens: 200,
    },
    completion_tokens_details: {
      reasoning_tokens: 20,
    },
  });

  assert.deepStrictEqual(tokens, {
    input: 1_000,
    output: 50,
    cacheRead: 600,
    cacheCreation: 200,
    reasoning: 20,
  });
});

test("normalizeUsageToCostTokens expands provider formats that report cache separately", () => {
  const tokens = normalizeUsageToCostTokens({
    input_tokens: 100,
    output_tokens: 25,
    cache_read_input_tokens: 40,
    cache_creation_input_tokens: 20,
    reasoning_tokens: 5,
  });

  assert.deepStrictEqual(tokens, {
    input: 160,
    output: 25,
    cacheRead: 40,
    cacheCreation: 20,
    reasoning: 5,
  });
});
