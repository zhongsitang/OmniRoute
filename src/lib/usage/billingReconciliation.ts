import { getDbInstance } from "../db/core";
import { calculateCost } from "./costCalculator";
import {
  CODEX_FAST_SERVICE_TIER,
  isHistoricalGpt54FastModel,
  normalizeServiceTier,
} from "./serviceTier";

type JsonRecord = Record<string, unknown>;

const COST_BACKFILL_BATCH_SIZE = 500;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function buildUsageTokens(row: JsonRecord) {
  return {
    input: toNumber(row.tokens_input),
    output: toNumber(row.tokens_output),
    cacheRead: toNumber(row.tokens_cache_read),
    cacheCreation: toNumber(row.tokens_cache_creation),
    reasoning: toNumber(row.tokens_reasoning),
  };
}

export interface BillingReconciliationResult {
  usageServiceTierUpdated: number;
  callLogServiceTierUpdated: number;
  usageCostBackfilled: number;
  domainCostMirrorsAdjusted: number;
}

export async function reconcileStoredUsageBilling(): Promise<BillingReconciliationResult> {
  const db = getDbInstance();

  const normalizeUsageFast = db
    .prepare(
      `
      UPDATE usage_history
      SET service_tier = @serviceTier
      WHERE service_tier IS NOT NULL
        AND LOWER(TRIM(service_tier)) = 'fast'
    `
    )
    .run({ serviceTier: CODEX_FAST_SERVICE_TIER });
  const markHistoricalUsageFast = db
    .prepare(
      `
      UPDATE usage_history
      SET service_tier = @serviceTier
      WHERE service_tier IS NULL
        AND (model = 'gpt-5.4' OR model LIKE '%/gpt-5.4')
    `
    )
    .run({ serviceTier: CODEX_FAST_SERVICE_TIER });

  const normalizeCallLogFast = db
    .prepare(
      `
      UPDATE call_logs
      SET service_tier = @serviceTier
      WHERE service_tier IS NOT NULL
        AND LOWER(TRIM(service_tier)) = 'fast'
    `
    )
    .run({ serviceTier: CODEX_FAST_SERVICE_TIER });
  const markHistoricalCallLogFast = db
    .prepare(
      `
      UPDATE call_logs
      SET service_tier = @serviceTier
      WHERE service_tier IS NULL
        AND (model = 'gpt-5.4' OR model LIKE '%/gpt-5.4')
    `
    )
    .run({ serviceTier: CODEX_FAST_SERVICE_TIER });

  const selectUsageRows = db.prepare(
    `
    SELECT
      id,
      provider,
      model,
      service_tier,
      tokens_input,
      tokens_output,
      tokens_cache_read,
      tokens_cache_creation,
      tokens_reasoning
    FROM usage_history
    WHERE cost_usd IS NULL
      AND provider IS NOT NULL
      AND model IS NOT NULL
      AND TRIM(provider) <> ''
      AND TRIM(model) <> ''
    ORDER BY id ASC
    LIMIT @limit
  `
  );
  const updateUsageCost = db.prepare(
    `
    UPDATE usage_history
    SET cost_usd = @costUsd,
        service_tier = COALESCE(@serviceTier, service_tier)
    WHERE id = @id
  `
  );

  let usageCostBackfilled = 0;

  while (true) {
    const rows = selectUsageRows.all({ limit: COST_BACKFILL_BATCH_SIZE }) as unknown[];
    if (rows.length === 0) break;

    for (const rawRow of rows) {
      const row = asRecord(rawRow);
      const id = row.id;
      const provider = toStringOrNull(row.provider);
      const model = toStringOrNull(row.model);
      if (id === null || id === undefined || !provider || !model) continue;

      const serviceTier =
        normalizeServiceTier(row.service_tier) ??
        (isHistoricalGpt54FastModel(model) ? CODEX_FAST_SERVICE_TIER : null);
      const costUsd = await calculateCost(provider, model, buildUsageTokens(row), {
        serviceTier,
      });

      updateUsageCost.run({
        id,
        serviceTier,
        costUsd,
      });
      usageCostBackfilled += 1;
    }
  }

  return {
    usageServiceTierUpdated: normalizeUsageFast.changes + markHistoricalUsageFast.changes,
    callLogServiceTierUpdated: normalizeCallLogFast.changes + markHistoricalCallLogFast.changes,
    usageCostBackfilled,
    domainCostMirrorsAdjusted: 0,
  };
}
