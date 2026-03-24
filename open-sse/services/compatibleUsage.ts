import {
  getFieldValue,
  parseResetTime,
  toNonEmptyString,
  toNumber,
  toRecord,
  type JsonRecord,
} from "./usageShared.ts";
import { getNextDailyResetAt } from "@/shared/utils/timezone";

const OPENAI_COMPATIBLE_PREFIX = "openai-compatible-";
const ANTHROPIC_COMPATIBLE_PREFIX = "anthropic-compatible-";
const MAX_NESTED_SEARCH_DEPTH = 5;

type CompatibleBalancePeriod = "daily" | "weekly" | "monthly";
type CompatibleBalanceInfo = {
  kind: "periodic" | "wallet";
  unit: string;
  remaining: number;
  limit: number | null;
  used: number | null;
  period: CompatibleBalancePeriod | null;
  expiresAt: string | null;
  resetAt: string | null;
};

type CompatibleUsageResponse =
  | {
      usageType: "compatible-balance";
      plan: string | null;
      balance: CompatibleBalanceInfo;
    }
  | {
      plan: string | null;
      message: string;
    };

export function isOpenAICompatibleProvider(provider: unknown): provider is string {
  return typeof provider === "string" && provider.startsWith(OPENAI_COMPATIBLE_PREFIX);
}

export function isAnthropicCompatibleProvider(provider: unknown): provider is string {
  return typeof provider === "string" && provider.startsWith(ANTHROPIC_COMPATIBLE_PREFIX);
}

export function isCompatibleProvider(provider: unknown): provider is string {
  return isOpenAICompatibleProvider(provider) || isAnthropicCompatibleProvider(provider);
}

function findNestedValue(
  source: unknown,
  candidateKeys: string[],
  depth = 0,
  seen: Set<unknown> = new Set()
): unknown {
  if (depth > MAX_NESTED_SEARCH_DEPTH || source === null || source === undefined) return null;
  if (typeof source !== "object") return null;
  if (seen.has(source)) return null;
  seen.add(source);

  if (Array.isArray(source)) {
    for (const item of source) {
      const found = findNestedValue(item, candidateKeys, depth + 1, seen);
      if (found !== null && found !== undefined) return found;
    }
    return null;
  }

  const record = source as JsonRecord;
  for (const key of candidateKeys) {
    if (record[key] !== undefined && record[key] !== null) {
      return record[key];
    }
  }

  for (const value of Object.values(record)) {
    const found = findNestedValue(value, candidateKeys, depth + 1, seen);
    if (found !== null && found !== undefined) return found;
  }

  return null;
}

function findNestedRecord(
  source: unknown,
  matcher: (record: JsonRecord) => boolean,
  depth = 0,
  seen: Set<unknown> = new Set()
): JsonRecord | null {
  if (depth > MAX_NESTED_SEARCH_DEPTH || source === null || source === undefined) return null;
  if (typeof source !== "object") return null;
  if (seen.has(source)) return null;
  seen.add(source);

  if (Array.isArray(source)) {
    for (const item of source) {
      const found = findNestedRecord(item, matcher, depth + 1, seen);
      if (found) return found;
    }
    return null;
  }

  const record = source as JsonRecord;
  if (matcher(record)) return record;

  for (const value of Object.values(record)) {
    const found = findNestedRecord(value, matcher, depth + 1, seen);
    if (found) return found;
  }

  return null;
}

function inferLocalResetTime(
  period: CompatibleBalancePeriod | null,
  providerSpecificData: JsonRecord = {}
): string | null {
  if (period !== "daily") return null;
  return getNextDailyResetAt(providerSpecificData.resetTimezone);
}

function pickCompatiblePeriodWindow(subscription: JsonRecord): {
  period: CompatibleBalancePeriod;
  limit: number;
  used: number;
} | null {
  const periodConfigs: Array<{
    period: CompatibleBalancePeriod;
    limitKey: string;
    usedKey: string;
  }> = [
    { period: "daily", limitKey: "daily_limit_usd", usedKey: "daily_usage_usd" },
    { period: "weekly", limitKey: "weekly_limit_usd", usedKey: "weekly_usage_usd" },
    { period: "monthly", limitKey: "monthly_limit_usd", usedKey: "monthly_usage_usd" },
  ];

  for (const config of periodConfigs) {
    const limit = toNumber(subscription[config.limitKey], Number.NaN);
    if (!Number.isFinite(limit) || limit <= 0) continue;

    return {
      period: config.period,
      limit: Math.max(limit, 0),
      used: Math.max(toNumber(subscription[config.usedKey], 0), 0),
    };
  }

  return null;
}

function getCompatiblePeriodResetAt(
  source: JsonRecord,
  subscription: JsonRecord,
  period: CompatibleBalancePeriod
): string | null {
  const explicitReset =
    source.resetAt ??
    source.reset_at ??
    subscription[`${period}_reset_at`] ??
    subscription[`${period}ResetAt`] ??
    subscription.resetAt ??
    subscription.reset_at;

  return parseResetTime(explicitReset);
}

function parseCompatibleBalanceResponse(
  data: unknown,
  providerSpecificData: JsonRecord = {}
): CompatibleUsageResponse {
  const source = toRecord(data);
  const directSubscription = toRecord(source.subscription);
  const subscription =
    Object.keys(directSubscription).length > 0
      ? directSubscription
      : (findNestedRecord(source, (record) =>
          ["daily_limit_usd", "weekly_limit_usd", "monthly_limit_usd"].some(
            (key) => record[key] !== undefined
          )
        ) ?? {});
  const periodWindow = pickCompatiblePeriodWindow(subscription);
  const plan =
    toNonEmptyString(source.planName) ||
    toNonEmptyString(source.plan) ||
    toNonEmptyString(findNestedValue(source, ["planName", "plan", "title", "tier"])) ||
    null;
  const expiresAt = parseResetTime(
    getFieldValue(subscription, "expires_at", "expiresAt") ??
      findNestedValue(source, ["expires_at", "expiresAt", "expire_at", "expireAt", "expiry"])
  );
  const remainingFromRemaining = toNumber(
    source.remaining ?? findNestedValue(source, ["remaining", "remaining_amount", "remainingUsd"]),
    Number.NaN
  );
  const remainingFromBalance = toNumber(
    source.balance ??
      findNestedValue(source, [
        "balance",
        "wallet_balance",
        "walletBalance",
        "credit_balance",
        "creditBalance",
        "available_balance",
        "availableBalance",
      ]),
    Number.NaN
  );
  const resolvedUnit =
    toNonEmptyString(source.unit) ||
    toNonEmptyString(
      findNestedValue(source, ["unit", "currency", "currency_unit", "currencyUnit"])
    ) ||
    null;

  if (periodWindow) {
    const remaining = Number.isFinite(remainingFromRemaining)
      ? Math.max(remainingFromRemaining, 0)
      : Math.max(periodWindow.limit - periodWindow.used, 0);

    return {
      usageType: "compatible-balance",
      plan,
      balance: {
        kind: "periodic",
        unit: resolvedUnit || "USD",
        remaining,
        limit: periodWindow.limit,
        used: Math.min(Math.max(periodWindow.used, 0), periodWindow.limit),
        period: periodWindow.period,
        expiresAt,
        resetAt:
          getCompatiblePeriodResetAt(source, subscription, periodWindow.period) ||
          inferLocalResetTime(periodWindow.period, providerSpecificData),
      },
    };
  }

  const walletRemaining = Number.isFinite(remainingFromBalance)
    ? remainingFromBalance
    : remainingFromRemaining;
  if (Number.isFinite(walletRemaining)) {
    return {
      usageType: "compatible-balance",
      plan,
      balance: {
        kind: "wallet",
        unit: resolvedUnit || "",
        remaining: Math.max(walletRemaining, 0),
        limit: null,
        used: null,
        period: null,
        expiresAt,
        resetAt: null,
      },
    };
  }

  return {
    plan,
    message:
      toNonEmptyString(source.message) ||
      toNonEmptyString(findNestedValue(source, ["message", "detail", "error", "error_message"])) ||
      "Compatible provider usage endpoint returned an unsupported format.",
  };
}

export async function getCompatibleUsage(
  provider: string,
  apiKey: unknown,
  providerSpecificData: Record<string, unknown> = {}
): Promise<CompatibleUsageResponse> {
  try {
    const key = toNonEmptyString(apiKey);
    if (!key) {
      return {
        plan: null,
        message: "Compatible provider API key missing. Please update the connection key.",
      };
    }

    const baseUrl = toNonEmptyString(providerSpecificData.baseUrl);
    if (!baseUrl) {
      return {
        plan: null,
        message: `No base URL configured for ${provider}.`,
      };
    }

    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/usage`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return {
          plan: null,
          message: "Compatible provider API key invalid or access denied. Please update the key.",
        };
      }

      const errorText = await response.text();
      throw new Error(`Compatible provider usage API error (${response.status}): ${errorText}`);
    }

    return parseCompatibleBalanceResponse(await response.json(), providerSpecificData);
  } catch (error) {
    throw new Error(`Failed to fetch compatible provider usage: ${(error as Error).message}`);
  }
}
