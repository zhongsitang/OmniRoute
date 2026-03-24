import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function assertAlmostEqual(actual, expected, epsilon = 1e-9, message = "") {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    message || `expected ${actual} to be within ${epsilon} of ${expected}`
  );
}

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-billing-reporting-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const usageHistory = await import("../../src/lib/usage/usageHistory.ts");
const callLogs = await import("../../src/lib/usage/callLogs.ts");
const usageStats = await import("../../src/lib/usage/usageStats.ts");
const usageAnalytics = await import("../../src/lib/usageAnalytics.ts");
const billingReconciliation = await import("../../src/lib/usage/billingReconciliation.ts");
const costRules = await import("../../src/domain/costRules.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  costRules.resetCostData();
}

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("usage history and call logs persist billing metadata", async () => {
  await resetStorage();

  await usageHistory.saveRequestUsage({
    provider: "codex",
    model: "gpt-5.4",
    tokens: { input: 123, output: 45 },
    serviceTier: "priority",
    costUsd: 1.2345,
    timestamp: new Date().toISOString(),
  });

  await callLogs.saveCallLog({
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    provider: "codex",
    model: "gpt-5.4",
    tokens: { input: 123, output: 45 },
    serviceTier: "priority",
    costUsd: 2.3456,
  });

  const history = await usageHistory.getUsageHistory();
  assert.equal(history.length, 1);
  assert.equal(history[0].serviceTier, "priority");
  assert.equal(history[0].costUsd, 1.2345);

  const logs = await callLogs.getCallLogs({ limit: 1 });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].serviceTier, "priority");
  assert.equal(logs[0].costUsd, 2.3456);
});

test("usage stats and analytics prefer stored cost_usd", async () => {
  await resetStorage();

  await usageHistory.saveRequestUsage({
    provider: "codex",
    model: "gpt-5.4",
    tokens: { input: 10, output: 5 },
    serviceTier: "priority",
    costUsd: 9.99,
    timestamp: new Date().toISOString(),
  });

  const stats = await usageStats.getUsageStats();
  assert.equal(stats.totalCost, 9.99);

  const db = await usageHistory.getUsageDb();
  const analytics = await usageAnalytics.computeAnalytics(db.data.history, "30d", {});
  assert.equal(analytics.summary.totalCost, 9.99);
});

test("billing reconciliation backfills historical gpt-5.4 fast rows", async () => {
  await resetStorage();

  const db = core.getDbInstance();
  const timestamp = new Date().toISOString();
  const provider = "openai-compatible-responses-legacy";

  await settingsDb.updatePricing({
    [provider]: {
      "gpt-5.4": {
        input: 2.5,
        cached: 0.25,
        output: 15,
      },
    },
  });

  db.prepare(
    `
    INSERT INTO usage_history (
      provider, model, connection_id, api_key_id, api_key_name,
      tokens_input, tokens_output, tokens_cache_read, tokens_cache_creation, tokens_reasoning,
      status, success, latency_ms, ttft_ms, error_code, timestamp
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
  ).run(
    provider,
    "gpt-5.4",
    null,
    "legacy-key",
    "Legacy Key",
    1000,
    100,
    0,
    0,
    0,
    "200",
    1,
    0,
    0,
    null,
    timestamp
  );

  const reconciliation = await billingReconciliation.reconcileStoredUsageBilling();
  assert.equal(reconciliation.usageServiceTierUpdated, 1);
  assert.equal(reconciliation.usageCostBackfilled, 1);

  const row = db
    .prepare("SELECT service_tier, cost_usd FROM usage_history WHERE api_key_id = ?")
    .get("legacy-key");
  assert.equal(row.service_tier, "priority");
  assertAlmostEqual(row.cost_usd, 0.008, 1e-9);
});

test("budget summary counts explicit auxiliary spend and ignores legacy domain rows", async () => {
  await resetStorage();

  const db = core.getDbInstance();
  const now = Date.now();
  const iso = new Date(now).toISOString();

  costRules.setBudget("budget-key", { dailyLimitUsd: 0.02, warningThreshold: 0.8 });

  db.prepare(
    `
    INSERT INTO usage_history (
      provider, model, connection_id, api_key_id, api_key_name,
      tokens_input, tokens_output, tokens_cache_read, tokens_cache_creation, tokens_reasoning,
      status, success, latency_ms, ttft_ms, error_code, service_tier, cost_usd, timestamp
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
  ).run(
    "openai-compatible-responses-legacy",
    "gpt-5.4",
    null,
    "budget-key",
    "Budget Key",
    1000,
    100,
    0,
    0,
    0,
    "200",
    1,
    0,
    0,
    null,
    "priority",
    0.008,
    iso
  );

  costRules.recordCost("budget-key", 0.004);

  db.prepare(
    "INSERT INTO domain_cost_history (api_key_id, cost, source, timestamp) VALUES (?, ?, ?, ?)"
  ).run("budget-key", 0.5, null, now + 500);

  const rows = db
    .prepare(
      "SELECT cost, source FROM domain_cost_history WHERE api_key_id = ? ORDER BY timestamp ASC"
    )
    .all("budget-key");
  assertAlmostEqual(rows[0].cost, 0.004, 1e-9);
  assert.equal(rows[0].source, "aux");
  assertAlmostEqual(rows[1].cost, 0.5, 1e-9);
  assert.equal(rows[1].source, null);

  const summary = costRules.getCostSummary("budget-key");
  assertAlmostEqual(summary.dailyTotal, 0.012, 1e-9);
  assertAlmostEqual(summary.monthlyTotal, 0.012, 1e-9);
  assert.equal(summary.totalEntries, 2);

  const budgetCheck = costRules.checkBudget("budget-key");
  assert.equal(budgetCheck.allowed, true);
  assertAlmostEqual(budgetCheck.remaining, 0.008, 1e-9);
});

test("billing reconciliation leaves legacy domain cost history untouched", async () => {
  await resetStorage();

  const db = core.getDbInstance();
  const now = Date.now();
  const iso = new Date(now).toISOString();

  db.prepare(
    `
    INSERT INTO usage_history (
      provider, model, connection_id, api_key_id, api_key_name,
      tokens_input, tokens_output, tokens_cache_read, tokens_cache_creation, tokens_reasoning,
      status, success, latency_ms, ttft_ms, error_code, service_tier, cost_usd, timestamp
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
  ).run(
    "codex",
    "gpt-5.4",
    null,
    "budget-key",
    "Budget Key",
    0,
    0,
    0,
    0,
    0,
    "200",
    1,
    0,
    0,
    null,
    "priority",
    0.008,
    iso
  );

  db.prepare(
    "INSERT INTO domain_cost_history (api_key_id, cost, source, timestamp) VALUES (?, ?, ?, ?)"
  ).run("budget-key", 0.004, null, now);

  const reconciliation = await billingReconciliation.reconcileStoredUsageBilling();
  assert.equal(reconciliation.domainCostMirrorsAdjusted, 0);

  const row = db
    .prepare("SELECT cost, source FROM domain_cost_history WHERE api_key_id = ?")
    .get("budget-key");
  assertAlmostEqual(row.cost, 0.004, 1e-9);
  assert.equal(row.source, null);

  const summary = costRules.getCostSummary("budget-key");
  assertAlmostEqual(summary.dailyTotal, 0.008, 1e-9);
  assertAlmostEqual(summary.monthlyTotal, 0.008, 1e-9);
  assert.equal(summary.totalEntries, 1);
});
