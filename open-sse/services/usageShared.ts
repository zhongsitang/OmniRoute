export type JsonRecord = Record<string, unknown>;

export function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

export function toNumber(value: unknown, fallback = 0): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function getFieldValue(source: unknown, snakeKey: string, camelKey: string): unknown {
  const obj = toRecord(source);
  return obj[snakeKey] ?? obj[camelKey] ?? null;
}

export function toNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function parseResetTime(resetValue: unknown): string | null {
  if (!resetValue) return null;

  try {
    if (resetValue instanceof Date) {
      return resetValue.toISOString();
    }

    if (typeof resetValue === "number") {
      return new Date(resetValue).toISOString();
    }

    if (typeof resetValue === "string") {
      return new Date(resetValue).toISOString();
    }

    return null;
  } catch (error) {
    console.warn(`Failed to parse reset time: ${String(resetValue)}`, error);
    return null;
  }
}
