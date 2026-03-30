import { getModelsByProviderId } from "@omniroute/open-sse/config/providerModels.ts";
import type { BadgeVariant } from "@/shared/components/Badge";
import { safePercentage } from "@/shared/utils/formatting";
import {
  isAnthropicCompatibleProvider,
  isOpenAICompatibleProvider,
} from "@/shared/constants/providers";

type TranslateValues = Record<string, string | number | null | undefined>;

export type UsageTranslateFn = (key: string, values?: TranslateValues) => string;
export type LimitsGroupBy = "none" | "type" | "environment";

export type CompatibleBalance = {
  kind: "periodic" | "wallet";
  unit: string;
  remaining: number;
  limit: number | null;
  used: number | null;
  period: "daily" | "weekly" | "monthly" | null;
  expiresAt: string | null;
  resetAt: string | null;
};

export type ProviderQuota = {
  name: string;
  used: number;
  total: number;
  resetAt: string | null;
  remainingPercentage?: number;
  modelKey?: string;
  message?: string;
};

export type ProviderUsageEntry = {
  mode: "quota" | "balance";
  quotas: ProviderQuota[];
  balance: CompatibleBalance | null;
  message: string | null;
  plan?: string | null;
  raw?: unknown;
};

export type ProviderConnectionSummary = {
  id: string;
  provider: string;
  authType?: string;
  name?: string | null;
  displayName?: string | null;
  group?: string | null;
  lastUsedAt?: string | null;
  providerSpecificData?: Record<string, unknown> | null;
};

export type ProviderMeta = {
  label: string;
  iconSrc: string;
  providerKind: string;
};

export type NormalizedPlanTier = {
  key: string;
  label: string;
  variant: BadgeVariant;
  rank: number;
  raw: string | null;
};

export type UsageSection = {
  id: string;
  label: string;
  icon: string;
  connections: ProviderConnectionSummary[];
};

export type BalanceDisplayState = {
  heading: string;
  remainingAmount: string;
  planText: string | null;
  progressRemaining: number | null;
  progressColors: ReturnType<typeof getBarColor>;
  pillColors: { bg: string; text: string };
  resetText: string | null;
  expiresText: string | null;
  hasProgress: boolean;
  barFillWidth: string;
  barFillColor: string;
  percentText: string;
  title?: string;
};

const PROVIDER_CONFIG: Record<string, { label: string }> = {
  antigravity: { label: "Antigravity" },
  github: { label: "GitHub Copilot" },
  kiro: { label: "Kiro AI" },
  codex: { label: "OpenAI Codex" },
  claude: { label: "Claude Code" },
  glm: { label: "GLM (Z.AI)" },
  "kimi-coding": { label: "Kimi Coding" },
};

const WALLET_PILL_COLORS = { bg: "rgba(20,184,166,0.12)", text: "#0f766e" };

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function toNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getCompatibleProviderLabel(
  connection: ProviderConnectionSummary,
  fallbackLabel: string
): string {
  const providerSpecificData =
    connection.providerSpecificData && typeof connection.providerSpecificData === "object"
      ? connection.providerSpecificData
      : {};

  return (
    toNonEmptyString(providerSpecificData.nodeName) ||
    toNonEmptyString(providerSpecificData.prefix) ||
    toNonEmptyString(connection.displayName) ||
    toNonEmptyString(connection.name) ||
    fallbackLabel
  );
}

function normalizeCompatibleBalance(rawBalance: unknown): CompatibleBalance | null {
  if (!rawBalance || typeof rawBalance !== "object") return null;

  const balance = rawBalance as Record<string, unknown>;
  const remaining = toFiniteNumber(balance.remaining);
  if (remaining === null) return null;

  const kind = balance.kind === "periodic" ? "periodic" : "wallet";
  const limit = toFiniteNumber(balance.limit);
  const used = toFiniteNumber(balance.used);
  const period = toNonEmptyString(balance.period)?.toLowerCase();

  return {
    kind,
    unit: toNonEmptyString(balance.unit) || "",
    remaining: Math.max(remaining, 0),
    limit: limit !== null ? Math.max(limit, 0) : null,
    used: used !== null ? Math.max(used, 0) : null,
    period: period === "daily" || period === "weekly" || period === "monthly" ? period : null,
    expiresAt: toNonEmptyString(balance.expiresAt),
    resetAt: toNonEmptyString(balance.resetAt),
  };
}

function getUsageSectionKey(
  usageEntry: ProviderUsageEntry | undefined,
  error: string | null | undefined
): "quota" | "budget" | "balance" | "unavailable" {
  if (
    error ||
    hasUsageMessageOnly(usageEntry) ||
    (usageEntry?.mode === "balance" && !usageEntry.balance)
  ) {
    return "unavailable";
  }

  if (usageEntry?.balance?.kind === "wallet") return "balance";
  if (usageEntry?.balance?.kind === "periodic") return "budget";
  if (usageEntry?.quotas?.length) return "quota";
  return "unavailable";
}

export function formatBalanceNumber(value: unknown, maximumFractionDigits = 2): string {
  const amount = toFiniteNumber(value);
  if (amount === null) return "-";

  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: Math.min(2, maximumFractionDigits),
    maximumFractionDigits,
  }).format(amount);
}

export function formatBalanceAmount(value: unknown, unit: unknown): string {
  const amountText = formatBalanceNumber(value);
  if (amountText === "-") return amountText;

  const normalizedUnit = toNonEmptyString(unit);
  if (!normalizedUnit) return amountText;
  if (normalizedUnit.toUpperCase() === "USD") return `$${amountText} ${normalizedUnit}`;
  return `${amountText} ${normalizedUnit}`;
}

/**
 * Format ISO date string to countdown format (inspired by vscode-antigravity-cockpit)
 * @param {string|Date} date - ISO date string or Date object
 * @returns {string} Formatted countdown (e.g., "2d 5h 30m", "4h 40m", "15m") or "-"
 */
function formatResetTime(date: string | Date | null | undefined): string {
  if (!date) return "-";

  try {
    const resetDate = typeof date === "string" ? new Date(date) : date;
    const now = new Date();
    const diffMs = resetDate.getTime() - now.getTime();

    if (diffMs <= 0) return "-";

    const totalMinutes = Math.ceil(diffMs / (1000 * 60));
    if (totalMinutes < 60) {
      return `${totalMinutes}m`;
    }

    const totalHours = Math.floor(totalMinutes / 60);
    const remainingMinutes = totalMinutes % 60;
    if (totalHours < 24) {
      return `${totalHours}h ${remainingMinutes}m`;
    }

    const days = Math.floor(totalHours / 24);
    const remainingHours = totalHours % 24;
    return `${days}d ${remainingHours}h ${remainingMinutes}m`;
  } catch {
    return "-";
  }
}

export function formatCountdownLabel(value: string | null | undefined): string | null {
  const countdown = formatResetTime(value);
  return countdown === "-" ? null : countdown;
}

export function getBarColor(remaining: number) {
  if (remaining > 70) return { bar: "#22c55e", text: "#22c55e", bg: "rgba(34,197,94,0.12)" };
  if (remaining >= 30) return { bar: "#eab308", text: "#eab308", bg: "rgba(234,179,8,0.12)" };
  return { bar: "#ef4444", text: "#ef4444", bg: "rgba(239,68,68,0.12)" };
}

export function getShortModelName(name: string): string {
  const map: Record<string, string> = {
    "gemini-3-pro-high": "G3 Pro",
    "gemini-3-pro-low": "G3 Pro Low",
    "gemini-3-flash": "G3 Flash",
    "gemini-2.5-flash": "G2.5 Flash",
    "claude-opus-4-6-thinking": "Opus 4.6 Tk",
    "claude-opus-4-5-thinking": "Opus 4.5 Tk",
    "claude-opus-4-5": "Opus 4.5",
    "claude-sonnet-4-5-thinking": "Sonnet 4.5 Tk",
    "claude-sonnet-4-5": "Sonnet 4.5",
    chat: "Chat",
    completions: "Completions",
    premium_interactions: "Premium",
    session: "Session",
    weekly: "Weekly",
    code_review: "Review",
    agentic_request: "Agentic",
    agentic_request_freetrial: "Agentic (Trial)",
  };
  return map[name] || name;
}

export function getI18nOrFallback(
  t: UsageTranslateFn,
  key: string,
  fallback: string,
  values?: TranslateValues
): string {
  try {
    return t(key, values);
  } catch {
    return fallback;
  }
}

export function formatDateTimeShort(
  value: string | null | undefined,
  locale: string
): string | null {
  if (!value) return null;

  try {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;

    return date.toLocaleString(locale, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return null;
  }
}

export function formatLastUsed(
  value: string | null | undefined,
  t: UsageTranslateFn,
  locale: string
): string {
  if (!value) return getI18nOrFallback(t, "neverUsed", "Never");

  try {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return getI18nOrFallback(t, "notAvailableSymbol", "-");

    const now = new Date();
    if (date.toDateString() === now.toDateString()) {
      return date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
    }

    return date.toLocaleString(locale, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return getI18nOrFallback(t, "notAvailableSymbol", "-");
  }
}

export function getProviderMeta(connection: ProviderConnectionSummary): ProviderMeta {
  if (isOpenAICompatibleProvider(connection.provider)) {
    const isResponses = connection.providerSpecificData?.apiType === "responses";
    return {
      label: getCompatibleProviderLabel(connection, "OpenAI Compatible"),
      iconSrc: isResponses ? "/providers/oai-r.png" : "/providers/oai-cc.png",
      providerKind: isResponses ? "Responses API" : "Chat API",
    };
  }

  if (isAnthropicCompatibleProvider(connection.provider)) {
    return {
      label: getCompatibleProviderLabel(connection, "Anthropic Compatible"),
      iconSrc: "/providers/anthropic-m.png",
      providerKind: "Messages API",
    };
  }

  const config = PROVIDER_CONFIG[connection.provider] || {
    label: connection.provider,
  };

  return {
    label: config.label,
    iconSrc: `/providers/${connection.provider}.png`,
    providerKind: config.label,
  };
}

export function getBalanceHeading(t: UsageTranslateFn, balance: CompatibleBalance | null): string {
  if (balance?.kind === "wallet") {
    return getI18nOrFallback(t, "walletShortLabel", "Wallet");
  }

  if (balance?.period === "daily") return getI18nOrFallback(t, "dailyShortLabel", "Daily");
  if (balance?.period === "weekly") return getI18nOrFallback(t, "weeklyShortLabel", "Weekly");
  if (balance?.period === "monthly") return getI18nOrFallback(t, "monthlyShortLabel", "Monthly");
  return getI18nOrFallback(t, "balanceShortLabel", "Balance");
}

export function getCompactUsageStatusLabel(
  t: UsageTranslateFn,
  value: string | null | undefined
): string {
  const normalized = typeof value === "string" ? value.toLowerCase() : "";
  if (!normalized) {
    return getI18nOrFallback(t, "usageUnavailableShort", "Usage unavailable");
  }

  if (normalized.includes("unsupported")) {
    return getI18nOrFallback(t, "usageUnsupportedShort", "Unsupported usage API");
  }

  if (
    normalized.includes("invalid") ||
    normalized.includes("denied") ||
    normalized.includes("unauthorized") ||
    normalized.includes("401") ||
    normalized.includes("403") ||
    normalized.includes("auth")
  ) {
    return getI18nOrFallback(t, "usageAuthShort", "Authorization failed");
  }

  return getI18nOrFallback(t, "usageUnavailableShort", "Usage unavailable");
}

export function hasUsageMessageOnly(usageEntry: ProviderUsageEntry | undefined): boolean {
  return (
    Boolean(usageEntry?.message) && usageEntry?.mode !== "balance" && !usageEntry?.quotas?.length
  );
}

export function getBalanceDisplayState(
  balance: CompatibleBalance | null,
  locale: string,
  t: UsageTranslateFn,
  plan?: string | null
): BalanceDisplayState | null {
  if (!balance) return null;

  const heading = getBalanceHeading(t, balance);
  const remainingAmount = formatBalanceAmount(balance.remaining, balance.unit);
  const derivedUsed =
    balance.used !== null && balance.used !== undefined
      ? balance.used
      : balance.kind === "periodic" && balance.limit !== null
        ? Math.max(balance.limit - balance.remaining, 0)
        : null;
  const progressRemaining =
    balance.kind === "periodic" && balance.limit
      ? Math.max(0, Math.min(100, calculatePercentage(derivedUsed, balance.limit)))
      : null;
  const progressColors =
    progressRemaining !== null ? getBarColor(progressRemaining) : getBarColor(100);
  const pillColors = balance.kind === "wallet" ? WALLET_PILL_COLORS : progressColors;
  const resetText = formatCountdownLabel(balance.resetAt);
  const expiresAtText = formatDateTimeShort(balance.expiresAt, locale);
  const expiresText =
    expiresAtText &&
    getI18nOrFallback(t, "expiresShortLabel", `Exp ${expiresAtText}`, { date: expiresAtText });
  const hasProgress = balance.kind === "periodic" && progressRemaining !== null;
  const percentText = hasProgress
    ? getI18nOrFallback(t, "percentageValue", `${progressRemaining}%`, {
        value: progressRemaining,
      })
    : getI18nOrFallback(t, "walletIndicator", "BAL");
  const planText = toNonEmptyString(plan);

  return {
    heading,
    remainingAmount,
    planText,
    progressRemaining,
    progressColors,
    pillColors,
    resetText,
    expiresText,
    hasProgress,
    barFillWidth: hasProgress ? `${Math.min(progressRemaining, 100)}%` : "36%",
    barFillColor: hasProgress ? progressColors.bar : "rgba(20,184,166,0.42)",
    percentText,
    title:
      [heading, remainingAmount, expiresAtText, planText].filter(Boolean).join(" · ") || undefined,
  };
}

/**
 * Calculate remaining percentage
 * @param {number} used - Used amount
 * @param {number} total - Total amount
 * @returns {number} Remaining percentage (0-100)
 */
export function calculatePercentage(
  used: number | null | undefined,
  total: number | null | undefined
): number {
  if (!total || total === 0) return 0;
  if (!used || used < 0) return 100;
  if (used >= total) return 0;

  return Math.round(((total - used) / total) * 100);
}

/**
 * Parse provider-specific quota structures into normalized array
 * @param {string} provider - Provider name (github, antigravity, codex, kiro, claude)
 * @param {Object} data - Raw quota data from provider
 * @returns {Array<Object>} Normalized quota objects with { name, used, total, resetAt }
 */
export function parseQuotaData(provider: string, data: any): ProviderQuota[] {
  if (!data || typeof data !== "object") return [];

  const normalizedQuotas: ProviderQuota[] = [];

  try {
    switch (provider.toLowerCase()) {
      case "github":
        if (data.quotas) {
          Object.entries(data.quotas).forEach(([name, quota]: [string, any]) => {
            if (quota?.unlimited && (!quota?.total || quota.total <= 0)) {
              return;
            }
            normalizedQuotas.push({
              name,
              used: quota.used || 0,
              total: quota.total || 0,
              resetAt: quota.resetAt || null,
              remainingPercentage: safePercentage(quota.remainingPercentage),
            });
          });
        }
        break;

      case "antigravity":
        if (data.quotas) {
          Object.entries(data.quotas).forEach(([modelKey, quota]: [string, any]) => {
            normalizedQuotas.push({
              name: quota.displayName || modelKey,
              modelKey,
              used: quota.used || 0,
              total: quota.total || 0,
              resetAt: quota.resetAt || null,
              remainingPercentage: safePercentage(quota.remainingPercentage),
            });
          });
        }
        break;

      case "codex":
      case "kiro":
        if (data.quotas) {
          Object.entries(data.quotas).forEach(([quotaType, quota]: [string, any]) => {
            normalizedQuotas.push({
              name: quotaType,
              used: quota.used || 0,
              total: quota.total || 0,
              resetAt: quota.resetAt || null,
            });
          });
        }
        break;

      case "claude":
        if (data.message) {
          normalizedQuotas.push({
            name: "error",
            used: 0,
            total: 0,
            resetAt: null,
            message: data.message,
          });
        } else if (data.quotas) {
          Object.entries(data.quotas).forEach(([name, quota]: [string, any]) => {
            normalizedQuotas.push({
              name,
              used: quota.used || 0,
              total: quota.total || 0,
              resetAt: quota.resetAt || null,
              remainingPercentage: safePercentage(quota.remainingPercentage),
            });
          });
        }
        break;

      default:
        if (data.quotas) {
          Object.entries(data.quotas).forEach(([name, quota]: [string, any]) => {
            normalizedQuotas.push({
              name,
              used: quota.used || 0,
              total: quota.total || 0,
              resetAt: quota.resetAt || null,
            });
          });
        }
    }
  } catch (error) {
    console.error(`Error parsing quota data for ${provider}:`, error);
    return [];
  }

  const modelOrder = getModelsByProviderId(provider);
  if (modelOrder.length > 0) {
    const orderMap = new Map(modelOrder.map((model, index) => [model.id, index]));

    normalizedQuotas.sort((a, b) => {
      const keyA = a.modelKey || a.name;
      const keyB = b.modelKey || b.name;
      const orderA = orderMap.get(keyA) ?? 999;
      const orderB = orderMap.get(keyB) ?? 999;
      return orderA - orderB;
    });
  }

  return normalizedQuotas;
}

export function parseProviderUsageData(provider: string, data: any): ProviderUsageEntry {
  const isCompatible =
    isOpenAICompatibleProvider(provider) || isAnthropicCompatibleProvider(provider);
  const message = typeof data?.message === "string" ? data.message : null;

  if (isCompatible && data?.usageType === "compatible-balance") {
    const balance = normalizeCompatibleBalance(data.balance);
    if (balance) {
      return {
        mode: "balance",
        quotas: [],
        balance,
        message,
      };
    }
  }

  return {
    mode: "quota",
    quotas: parseQuotaData(provider, data),
    balance: null,
    message,
  };
}

export function buildUsageSections({
  groupBy,
  connections,
  quotaData,
  errors,
  t,
}: {
  groupBy: LimitsGroupBy;
  connections: ProviderConnectionSummary[];
  quotaData: Record<string, ProviderUsageEntry | undefined>;
  errors: Record<string, string | null | undefined>;
  t: UsageTranslateFn;
}): UsageSection[] | null {
  if (groupBy === "none") return null;

  if (groupBy === "environment") {
    const groups = new Map<string, UsageSection>();

    for (const connection of connections) {
      const rawKey = connection.group || "ungrouped";
      const id = `env:${rawKey}`;
      const label = connection.group || t("ungrouped");
      if (!groups.has(id)) {
        groups.set(id, { id, label, icon: "folder", connections: [] });
      }
      groups.get(id)?.connections.push(connection);
    }

    return [...groups.values()];
  }

  const groups = new Map<"quota" | "budget" | "balance" | "unavailable", UsageSection>([
    [
      "quota",
      {
        id: "type:quota",
        label: getI18nOrFallback(t, "usageGroupQuota", "Quota"),
        icon: "query_stats",
        connections: [],
      },
    ],
    [
      "budget",
      {
        id: "type:budget",
        label: getI18nOrFallback(t, "usageGroupBudget", "Budget"),
        icon: "timer",
        connections: [],
      },
    ],
    [
      "balance",
      {
        id: "type:balance",
        label: getI18nOrFallback(t, "usageGroupBalance", "Wallet"),
        icon: "account_balance_wallet",
        connections: [],
      },
    ],
    [
      "unavailable",
      {
        id: "type:unavailable",
        label: getI18nOrFallback(t, "usageGroupUnavailable", "Unavailable"),
        icon: "error",
        connections: [],
      },
    ],
  ]);

  for (const connection of connections) {
    const sectionKey = getUsageSectionKey(quotaData[connection.id], errors[connection.id]);
    groups.get(sectionKey)?.connections.push(connection);
  }

  return ["quota", "budget", "balance", "unavailable"]
    .map((id) => groups.get(id))
    .filter((section): section is UsageSection =>
      Boolean(section && section.connections.length > 0)
    );
}

/**
 * Normalize provider-specific plan labels into a shared tier taxonomy.
 * Supported tiers: enterprise, business, team, ultra, pro, free, unknown.
 */
export function normalizePlanTier(plan: unknown): NormalizedPlanTier {
  const raw = typeof plan === "string" ? plan.trim() : "";
  if (!raw) {
    return { key: "unknown", label: "Unknown", variant: "default", rank: 0, raw: null };
  }

  const upper = raw.toUpperCase();

  if (upper.includes("PRO+") || upper.includes("PRO PLUS") || upper.includes("PROPLUS")) {
    return { key: "plus", label: "Pro+", variant: "secondary", rank: 4, raw };
  }

  if (upper.includes("ENTERPRISE") || upper.includes("CORP") || upper.includes("ORG")) {
    return { key: "enterprise", label: "Enterprise", variant: "info", rank: 7, raw };
  }

  if (upper.includes("TEAM") || upper.includes("CHATGPTTEAM")) {
    return { key: "team", label: "Team", variant: "info", rank: 6, raw };
  }

  if (upper.includes("BUSINESS") || upper.includes("STANDARD") || upper.includes("BIZ")) {
    return { key: "business", label: "Business", variant: "warning", rank: 5, raw };
  }

  if (upper.includes("STUDENT")) {
    return { key: "pro", label: "Student", variant: "primary", rank: 3, raw };
  }

  if (upper.includes("ULTRA")) {
    return { key: "ultra", label: "Ultra", variant: "success", rank: 4, raw };
  }

  if (upper.includes("PRO") || upper.includes("PREMIUM")) {
    return { key: "pro", label: "Pro", variant: "primary", rank: 3, raw };
  }

  if (upper.includes("PLUS") || upper.includes("PAID")) {
    return { key: "plus", label: "Plus", variant: "secondary", rank: 2, raw };
  }

  if (
    upper.includes("FREE") ||
    upper.includes("BASIC") ||
    upper.includes("TRIAL") ||
    upper.includes("LEGACY")
  ) {
    return { key: "free", label: "Free", variant: "default", rank: 1, raw };
  }

  return { key: "unknown", label: "Unknown", variant: "default", rank: 0, raw };
}
