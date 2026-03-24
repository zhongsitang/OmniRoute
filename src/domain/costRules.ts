/**
 * Cost Rules — Domain Layer (T-19)
 *
 * Business rules for cost management: budget thresholds,
 * quota checking, and cost summaries per API key.
 *
 * State is persisted in SQLite via domainState.js.
 *
 * @module domain/costRules
 */

import { saveBudget, loadBudget, saveCostEntry, deleteAllCostData } from "../lib/db/domainState";
import { getDbInstance } from "../lib/db/core";

interface BudgetConfig {
  dailyLimitUsd: number;
  monthlyLimitUsd?: number;
  warningThreshold?: number;
}

const AUXILIARY_COST_SOURCE = "aux";

function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function getCostWindowBreakdown(apiKeyId: string, sinceTimestamp: number) {
  const db = getDbInstance();
  const sinceIso = new Date(sinceTimestamp).toISOString();

  const usageSummary = db
    .prepare(
      `
      SELECT
        COUNT(*) AS entry_count,
        COALESCE(SUM(cost_usd), 0) AS total_cost
      FROM usage_history
      WHERE api_key_id = ?
        AND timestamp >= ?
        AND cost_usd IS NOT NULL
    `
    )
    .get(apiKeyId, sinceIso) as { entry_count?: unknown; total_cost?: unknown } | undefined;

  const auxiliarySummary = db
    .prepare(
      `
      SELECT
        COUNT(*) AS entry_count,
        COALESCE(SUM(cost), 0) AS total_cost
      FROM domain_cost_history
      WHERE api_key_id = ?
        AND timestamp >= ?
        AND source = ?
    `
    )
    .get(apiKeyId, sinceTimestamp, AUXILIARY_COST_SOURCE) as
    | { entry_count?: unknown; total_cost?: unknown }
    | undefined;

  const usageEntries = toNumber(usageSummary?.entry_count);
  const usageTotal = toNumber(usageSummary?.total_cost);
  const auxiliaryEntries = toNumber(auxiliarySummary?.entry_count);
  const auxiliaryTotal = toNumber(auxiliarySummary?.total_cost);

  return {
    total: usageTotal + auxiliaryTotal,
    totalEntries: usageEntries + auxiliaryEntries,
  };
}

/**
 * @typedef {Object} BudgetConfig
 * @property {number} dailyLimitUsd - Max daily spend in USD
 * @property {number} [monthlyLimitUsd] - Max monthly spend in USD
 * @property {number} [warningThreshold=0.8] - Alert when usage reaches this fraction
 */

/**
 * @typedef {Object} CostEntry
 * @property {number} cost - Cost in USD
 * @property {number} timestamp - Unix timestamp
 */

/** @type {Map<string, BudgetConfig>} In-memory cache for budgets */
const budgets = new Map<string, BudgetConfig>();

/** @type {boolean} */
let _budgetsLoaded = false;

/**
 * Set budget for an API key.
 *
 * @param {string} apiKeyId
 * @param {BudgetConfig} config
 */
export function setBudget(apiKeyId: string, config: BudgetConfig) {
  const normalized = {
    dailyLimitUsd: config.dailyLimitUsd,
    monthlyLimitUsd: config.monthlyLimitUsd || 0,
    warningThreshold: config.warningThreshold ?? 0.8,
  };
  budgets.set(apiKeyId, normalized);
  try {
    saveBudget(apiKeyId, normalized);
  } catch {
    // Non-critical: in-memory still works
  }
}

/**
 * Get budget config for an API key.
 *
 * @param {string} apiKeyId
 * @returns {BudgetConfig | null}
 */
export function getBudget(apiKeyId: string): BudgetConfig | null {
  // Check in-memory cache first
  if (budgets.has(apiKeyId)) {
    return budgets.get(apiKeyId);
  }
  // Try loading from DB
  try {
    const fromDb = loadBudget(apiKeyId) as BudgetConfig | null;
    if (fromDb) {
      budgets.set(apiKeyId, fromDb);
      return fromDb;
    }
  } catch {
    // DB may not be ready
  }
  return null;
}

/**
 * Record a cost for an API key.
 *
 * @param {string} apiKeyId
 * @param {number} cost - Cost in USD
 */
export function recordCost(apiKeyId: string, cost: number): void {
  const timestamp = Date.now();
  try {
    saveCostEntry(apiKeyId, cost, timestamp, AUXILIARY_COST_SOURCE);
  } catch {
    // Non-critical
  }
}

/**
 * Check if an API key has remaining budget.
 *
 * @param {string} apiKeyId
 * @param {number} [additionalCost=0] - Projected cost to check
 * @returns {{ allowed: boolean, reason?: string, dailyUsed: number, dailyLimit: number, warningReached: boolean }}
 */
export function checkBudget(apiKeyId: string, additionalCost = 0) {
  const budget = getBudget(apiKeyId);
  if (!budget) {
    return { allowed: true, dailyUsed: 0, dailyLimit: 0, warningReached: false, remaining: 0 };
  }

  const dailyUsed = getDailyTotal(apiKeyId);
  const projectedTotal = dailyUsed + additionalCost;
  const warningReached = projectedTotal >= budget.dailyLimitUsd * budget.warningThreshold;
  const remaining = Math.max(0, budget.dailyLimitUsd - projectedTotal);

  if (projectedTotal > budget.dailyLimitUsd) {
    return {
      allowed: false,
      reason: `Daily budget exceeded: $${projectedTotal.toFixed(4)} / $${budget.dailyLimitUsd.toFixed(2)}`,
      dailyUsed,
      dailyLimit: budget.dailyLimitUsd,
      warningReached: true,
      remaining: 0,
    };
  }

  return {
    allowed: true,
    dailyUsed,
    dailyLimit: budget.dailyLimitUsd,
    warningReached,
    remaining,
  };
}

/**
 * Get daily total cost for an API key.
 *
 * @param {string} apiKeyId
 * @returns {number} Total cost today in USD
 */
export function getDailyTotal(apiKeyId: string): number {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const startMs = todayStart.getTime();

  try {
    return getCostWindowBreakdown(apiKeyId, startMs).total;
  } catch {
    return 0;
  }
}

/**
 * Get cost summary for an API key.
 *
 * @param {string} apiKeyId
 * @returns {{ dailyTotal: number, monthlyTotal: number, totalEntries: number, budget: BudgetConfig | null }}
 */
export function getCostSummary(apiKeyId: string) {
  const now = new Date();

  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  try {
    const dailySummary = getCostWindowBreakdown(apiKeyId, todayStart.getTime());
    const monthlySummary = getCostWindowBreakdown(apiKeyId, monthStart.getTime());

    return {
      dailyTotal: dailySummary.total,
      monthlyTotal: monthlySummary.total,
      totalCostToday: dailySummary.total,
      totalCostMonth: monthlySummary.total,
      totalEntries: monthlySummary.totalEntries,
      budget: getBudget(apiKeyId),
    };
  } catch {
    return {
      dailyTotal: 0,
      monthlyTotal: 0,
      totalCostToday: 0,
      totalCostMonth: 0,
      totalEntries: 0,
      budget: getBudget(apiKeyId),
    };
  }
}

/**
 * Clear all cost data (for testing).
 */
export function resetCostData() {
  budgets.clear();
  _budgetsLoaded = false;
  try {
    deleteAllCostData();
  } catch {
    // Non-critical
  }
}
