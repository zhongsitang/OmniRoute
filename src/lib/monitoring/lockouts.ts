import {
  classifyError,
  getAllModelLockouts,
} from "@omniroute/open-sse/services/accountFallback.ts";
import { getAccountDisplayName, getProviderDisplayName } from "@/lib/display/names";

type JsonRecord = Record<string, unknown>;

export interface ActiveLockoutEntry {
  key: string;
  scope: "account" | "model";
  source: "database" | "memory";
  provider: string;
  providerDisplayName: string;
  connectionId: string;
  accountName: string;
  model: string | null;
  scopedModelName: string;
  reason: string | null;
  reasonDetail: string | null;
  remainingMs: number;
  lockedAt: string | null;
  until: string;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function toNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function toFutureIsoString(value: unknown): string | null {
  const iso = toNonEmptyString(value);
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms <= Date.now()) return null;
  return iso;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function getProviderNodeLabel(connection: JsonRecord): string | null {
  const providerSpecificData = asRecord(connection.providerSpecificData);
  return (
    toNonEmptyString(providerSpecificData.nodeName) ||
    toNonEmptyString(providerSpecificData.prefix) ||
    null
  );
}

function getProviderLabel(connection: JsonRecord): string {
  const provider = toNonEmptyString(connection.provider);
  const providerNodeLabel = getProviderNodeLabel(connection);

  return (
    providerNodeLabel ||
    getProviderDisplayName(provider, null, {
      openAICompatibleLabel: "OpenAI Compatible",
      anthropicCompatibleLabel: "Anthropic Compatible",
      unknownLabel: "Unknown Provider",
    })
  );
}

function getRemainingMs(until: string): number {
  return Math.max(new Date(until).getTime() - Date.now(), 0);
}

function sortLockouts(a: ActiveLockoutEntry, b: ActiveLockoutEntry): number {
  const scopeRank = a.scope === b.scope ? 0 : a.scope === "account" ? -1 : 1;
  if (scopeRank !== 0) return scopeRank;
  if (a.remainingMs !== b.remainingMs) return b.remainingMs - a.remainingMs;
  return a.key.localeCompare(b.key);
}

function buildAccountLockout(connection: JsonRecord): ActiveLockoutEntry | null {
  const connectionId = toNonEmptyString(connection.id);
  const provider = toNonEmptyString(connection.provider);
  const until = toFutureIsoString(connection.rateLimitedUntil);

  if (!connectionId || !provider || !until || connection.isActive !== true) {
    return null;
  }

  const accountName = getAccountDisplayName({
    id: connectionId,
    name: toNonEmptyString(connection.name),
    displayName: toNonEmptyString(connection.displayName),
    email: toNonEmptyString(connection.email),
  });
  const providerDisplayName = getProviderLabel(connection);
  const errorCode = toFiniteNumber(connection.errorCode) ?? 0;
  const lastError = toNonEmptyString(connection.lastError);
  const classifiedReason = classifyError(errorCode, lastError || "");
  const fallbackReason = toNonEmptyString(connection.lastErrorType);

  return {
    key: `account:${connectionId}`,
    scope: "account",
    source: "database",
    provider,
    providerDisplayName,
    connectionId,
    accountName,
    model: null,
    scopedModelName: accountName,
    reason: classifiedReason !== "unknown" ? classifiedReason : fallbackReason,
    reasonDetail: lastError,
    remainingMs: getRemainingMs(until),
    lockedAt:
      toNonEmptyString(connection.lastErrorAt) || toNonEmptyString(connection.updatedAt) || null,
    until,
  };
}

function buildConnectionMap(connections: unknown[]): Map<string, JsonRecord> {
  return new Map(
    connections
      .map((connection) => asRecord(connection))
      .map((connection) => [toNonEmptyString(connection.id), connection] as const)
      .filter((entry): entry is [string, JsonRecord] => Boolean(entry[0]))
  );
}

function buildAccountLockouts(connections: unknown[]): ActiveLockoutEntry[] {
  return connections
    .map((connection) => buildAccountLockout(asRecord(connection)))
    .filter((lockout): lockout is ActiveLockoutEntry => Boolean(lockout));
}

export function buildActiveLockoutSnapshot(connections: unknown[]): ActiveLockoutEntry[] {
  const connectionMap = buildConnectionMap(connections);
  const accountLockouts = buildAccountLockouts(connections);
  const accountLockoutUntilByConnection = new Map(
    accountLockouts.map((lockout) => [lockout.connectionId, new Date(lockout.until).getTime()])
  );

  const modelLockouts = getAllModelLockouts()
    .map((lockout) => {
      const connection = connectionMap.get(lockout.connectionId) || {};
      const accountUntil = accountLockoutUntilByConnection.get(lockout.connectionId) || 0;
      const modelUntil = new Date(lockout.until).getTime();

      // Account-wide lockouts already cover provider/model failures for the same connection.
      if (accountUntil > 0 && modelUntil <= accountUntil) {
        return null;
      }

      const providerDisplayName = getProviderLabel({
        ...connection,
        provider: lockout.provider,
      });
      const accountName = getAccountDisplayName({
        id: lockout.connectionId,
        name: toNonEmptyString(connection.name),
        displayName: toNonEmptyString(connection.displayName),
        email: toNonEmptyString(connection.email),
      });

      return {
        key: `model:${lockout.provider}:${lockout.connectionId}:${lockout.model}`,
        scope: "model" as const,
        source: "memory" as const,
        provider: lockout.provider,
        providerDisplayName,
        connectionId: lockout.connectionId,
        accountName,
        model: toNonEmptyString(lockout.model),
        scopedModelName: lockout.model
          ? `${providerDisplayName} / ${lockout.model}`
          : providerDisplayName,
        reason: toNonEmptyString(lockout.reason),
        reasonDetail: null,
        remainingMs: lockout.remainingMs,
        lockedAt: toNonEmptyString(lockout.lockedAt),
        until: lockout.until,
      };
    })
    .filter((lockout): lockout is ActiveLockoutEntry => Boolean(lockout));

  return [...accountLockouts, ...modelLockouts].sort(sortLockouts);
}
