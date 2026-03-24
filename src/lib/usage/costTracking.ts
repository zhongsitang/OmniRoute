import { calculateCost } from "./costCalculator";
import { normalizeServiceTier } from "./serviceTier";

function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function getCacheMetrics(usage: Record<string, unknown>) {
  const promptDetails = asRecord(usage.prompt_tokens_details ?? usage.input_tokens_details);
  const cacheRead = toNumber(
    usage.cacheRead ??
      usage.cached_tokens ??
      usage.cache_read_input_tokens ??
      promptDetails.cached_tokens
  );
  const cacheCreation = toNumber(
    usage.cacheCreation ?? usage.cache_creation_input_tokens ?? promptDetails.cache_creation_tokens
  );

  return {
    cacheRead,
    cacheCreation,
    promptIncludesCache:
      usage.input !== undefined ||
      usage.cached_tokens !== undefined ||
      promptDetails.cached_tokens !== undefined ||
      promptDetails.cache_creation_tokens !== undefined,
  };
}

export function normalizeUsageToCostTokens(usage: unknown) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;

  const usageRecord = usage as Record<string, unknown>;
  const directInput = toNumber(usageRecord.input, Number.NaN);
  const { cacheRead, cacheCreation, promptIncludesCache } = getCacheMetrics(usageRecord);
  const promptTokens = toNumber(usageRecord.prompt_tokens ?? usageRecord.input_tokens, 0);
  const output = toNumber(
    usageRecord.output ?? usageRecord.completion_tokens ?? usageRecord.output_tokens,
    0
  );
  const completionDetails = asRecord(
    usageRecord.completion_tokens_details ?? usageRecord.output_tokens_details
  );
  const reasoning = toNumber(usageRecord.reasoning ?? usageRecord.reasoning_tokens, Number.NaN);

  return {
    input: Number.isFinite(directInput)
      ? directInput
      : promptIncludesCache
        ? promptTokens
        : promptTokens + cacheRead + cacheCreation,
    output,
    cacheRead,
    cacheCreation,
    reasoning: Number.isFinite(reasoning)
      ? reasoning
      : toNumber(completionDetails.reasoning_tokens, 0),
  };
}

export async function calculateUsageCost(
  provider: string,
  model: string,
  usage: unknown,
  options: Record<string, unknown> = {}
) {
  if (!provider || !model) return 0;

  const tokens = normalizeUsageToCostTokens(usage);
  if (!tokens) return 0;

  return calculateCost(provider, model, tokens, {
    serviceTier: normalizeServiceTier(options.serviceTier),
  });
}

export async function recordUsageCost(
  apiKeyInfo: any,
  provider: string,
  model: string,
  usage: unknown,
  options: Record<string, unknown> = {}
) {
  void apiKeyInfo;
  return calculateUsageCost(provider, model, usage, options);
}
