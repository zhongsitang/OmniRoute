/**
 * Model Availability — Domain Layer (T-19)
 *
 * Tracks model availability per provider with TTL-based cooldowns.
 * When a model becomes unavailable (rate-limited, erroring), it is
 * marked with a cooldown period. The availability report powers
 * the dashboard health view.
 *
 * @module domain/modelAvailability
 */

interface UnavailableEntry {
  provider: string;
  model: string;
  unavailableSince: number;
  cooldownMs: number;
  reason?: string;
}

export interface ModelAvailabilityInfo {
  provider: string;
  model: string;
  status: "cooldown";
  reason: string;
  remainingMs: number;
  unavailableSince: string;
  cooldownUntil: string;
  resetAt: string;
}

const unavailable = new Map<string, UnavailableEntry>();

/**
 * Build a composite key for provider+model.
 * @param {string} provider
 * @param {string} model
 * @returns {string}
 */
function makeKey(provider, model) {
  return `${provider}::${model}`;
}

/**
 * Check if a model is currently available.
 *
 * @param {string} provider - Provider ID (e.g. "openai", "anthropic")
 * @param {string} model - Model ID (e.g. "gpt-4o", "claude-sonnet-4-20250514")
 * @returns {boolean} true if model is available (not in cooldown)
 */
export function isModelAvailable(provider, model) {
  return getModelAvailabilityInfo(provider, model) === null;
}

/**
 * Mark a model as temporarily unavailable.
 *
 * @param {string} provider
 * @param {string} model
 * @param {number} [cooldownMs=60000] - Cooldown in milliseconds (default 60s)
 * @param {string} [reason] - Optional reason for unavailability
 */
export function setModelUnavailable(provider, model, cooldownMs = 60000, reason) {
  const key = makeKey(provider, model);
  unavailable.set(key, {
    provider,
    model,
    unavailableSince: Date.now(),
    cooldownMs,
    reason: reason || "unknown",
  });
}

/**
 * Clear unavailability for a model (e.g. after manual reset).
 *
 * @param {string} provider
 * @param {string} model
 * @returns {boolean} true if entry existed and was removed
 */
export function clearModelUnavailability(provider, model) {
  return unavailable.delete(makeKey(provider, model));
}

export function getModelAvailabilityInfo(
  provider: string,
  model: string
): ModelAvailabilityInfo | null {
  const key = makeKey(provider, model);
  const entry = unavailable.get(key);
  if (!entry) return null;

  const elapsed = Date.now() - entry.unavailableSince;
  if (elapsed >= entry.cooldownMs) {
    unavailable.delete(key);
    return null;
  }

  const remainingMs = entry.cooldownMs - elapsed;
  const resetAt = new Date(Date.now() + remainingMs).toISOString();
  return {
    provider: entry.provider,
    model: entry.model,
    status: "cooldown",
    reason: entry.reason || "unknown",
    remainingMs,
    unavailableSince: new Date(entry.unavailableSince).toISOString(),
    cooldownUntil: resetAt,
    resetAt,
  };
}

/**
 * Get a report of all currently unavailable models.
 *
 * @returns {Array<{ provider: string, model: string, status: string, reason: string, remainingMs: number, unavailableSince: string, cooldownUntil: string, resetAt: string }>}
 */
export function getAvailabilityReport() {
  const report: ModelAvailabilityInfo[] = [];

  for (const entry of unavailable.values()) {
    const info = getModelAvailabilityInfo(entry.provider, entry.model);
    if (!info) continue;
    report.push(info);
  }

  return report;
}

/**
 * Get total count of unavailable models.
 * @returns {number}
 */
export function getUnavailableCount() {
  // Prune expired entries first
  getAvailabilityReport();
  return unavailable.size;
}

/**
 * Reset all availability states (for testing or admin).
 */
export function resetAllAvailability() {
  unavailable.clear();
}
