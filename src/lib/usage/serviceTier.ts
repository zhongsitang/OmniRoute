const CODEX_FAST_SERVICE_TIER = "priority";

function toLowerString(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function normalizeServiceTier(value: unknown): string | null {
  const normalized = toLowerString(value);
  if (!normalized) return null;
  if (normalized === "fast") return CODEX_FAST_SERVICE_TIER;
  return normalized;
}

export function extractServiceTierFromRequestBody(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  return normalizeServiceTier(record.service_tier ?? record.serviceTier);
}

export function normalizeBillingModelName(model: string | null | undefined): string | null {
  if (typeof model !== "string" || model.length === 0) return null;
  if (!model.includes("/")) return model;
  const parts = model.split("/");
  return parts[parts.length - 1] || model;
}

export function isHistoricalGpt54FastModel(model: string | null | undefined): boolean {
  return normalizeBillingModelName(model) === "gpt-5.4";
}

export function isCodexFastServiceTier(
  provider: string | null | undefined,
  model: string | null | undefined,
  serviceTier: string | null | undefined
): boolean {
  const normalizedProvider = toLowerString(provider);
  const normalizedTier = normalizeServiceTier(serviceTier);
  return (
    normalizedTier === CODEX_FAST_SERVICE_TIER &&
    (normalizedProvider === "codex" ||
      normalizedProvider === "cx" ||
      isHistoricalGpt54FastModel(model))
  );
}

export { CODEX_FAST_SERVICE_TIER };
