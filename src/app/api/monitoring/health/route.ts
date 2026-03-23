import { NextResponse } from "next/server";
import { getCombos, getProviderConnections, getProviderNodes, getSettings } from "@/lib/localDb";
import { APP_CONFIG } from "@/shared/constants/config";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function toNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function getComboModelNames(combo: JsonRecord): string[] {
  if (!Array.isArray(combo.models)) return [];

  return combo.models
    .map((entry) => {
      if (typeof entry === "string") return toNonEmptyString(entry);
      if (isRecord(entry)) return toNonEmptyString(entry.model);
      return null;
    })
    .filter((entry): entry is string => Boolean(entry));
}

function resolveComboModelNames(
  combo: JsonRecord,
  comboMap: Map<string, JsonRecord>,
  visited = new Set<string>()
): string[] {
  const comboName = toNonEmptyString(combo.name);
  if (comboName) {
    if (visited.has(comboName)) return [];
    visited.add(comboName);
  }

  const resolved: string[] = [];
  for (const modelName of getComboModelNames(combo)) {
    const nestedCombo = comboMap.get(modelName);
    if (nestedCombo) {
      resolved.push(...resolveComboModelNames(nestedCombo, comboMap, new Set(visited)));
      continue;
    }
    resolved.push(modelName);
  }

  return resolved;
}

function buildConfiguredBreakerSets(
  connections: unknown[],
  providerNodes: unknown[],
  combos: unknown[]
): {
  configuredProviders: Set<string>;
  configuredComboBreakers: Set<string>;
} {
  const configuredProviders = new Set<string>();

  for (const connection of connections) {
    if (!isRecord(connection)) continue;
    const provider = toNonEmptyString(connection.provider);
    if (provider) configuredProviders.add(provider);
  }

  for (const node of providerNodes) {
    if (!isRecord(node)) continue;
    const identifiers = [node.id, node.prefix, node.apiType, node.provider];
    for (const identifier of identifiers) {
      const value = toNonEmptyString(identifier);
      if (value) configuredProviders.add(value);
    }
  }

  const activeCombos = (Array.isArray(combos) ? combos : []).filter(
    (combo) => isRecord(combo) && combo.isActive !== false
  ) as JsonRecord[];
  const comboMap = new Map(
    activeCombos
      .map((combo) => [toNonEmptyString(combo.name), combo] as const)
      .filter((entry): entry is [string, JsonRecord] => Boolean(entry[0]))
  );

  const configuredComboBreakers = new Set<string>();
  for (const combo of activeCombos) {
    for (const modelName of resolveComboModelNames(combo, comboMap)) {
      configuredComboBreakers.add(`combo:${modelName}`);
    }
  }

  return { configuredProviders, configuredComboBreakers };
}

function isConfiguredBreakerName(
  breakerName: string,
  configuredProviders: Set<string>,
  configuredComboBreakers: Set<string>
): boolean {
  if (breakerName.startsWith("combo:")) {
    return configuredComboBreakers.has(breakerName);
  }

  return configuredProviders.has(breakerName);
}

/**
 * GET /api/monitoring/health — System health overview
 *
 * Returns system info, provider health (circuit breakers),
 * rate limit status, and database stats.
 */
export async function GET() {
  try {
    const { getAllCircuitBreakerStatuses } = await import("@/shared/utils/circuitBreaker");
    const { getAllRateLimitStatus } = await import("@omniroute/open-sse/services/rateLimitManager");
    const { getAllModelLockouts } = await import("@omniroute/open-sse/services/accountFallback");
    const { getInflightCount } = await import("@omniroute/open-sse/services/requestDedup.ts");

    const [settings, connections, providerNodes, combos] = await Promise.all([
      getSettings(),
      getProviderConnections(),
      getProviderNodes(),
      getCombos(),
    ]);
    const circuitBreakers = getAllCircuitBreakerStatuses();
    const rateLimitStatus = getAllRateLimitStatus();
    const lockouts = getAllModelLockouts();
    const { getAllHealthStatuses } = await import("@/lib/localHealthCheck");
    const { configuredProviders, configuredComboBreakers } = buildConfiguredBreakerSets(
      connections,
      providerNodes,
      combos
    );

    // System info
    const system = {
      version: APP_CONFIG.version,
      nodeVersion: process.version,
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
      pid: process.pid,
      platform: process.platform,
    };

    // Provider health summary (circuitBreakers is an Array of { name, state, ... })
    const providerHealth = {};
    for (const cb of circuitBreakers) {
      // Skip test circuit breakers (leftover from unit tests)
      if (cb.name.startsWith("test-") || cb.name.startsWith("test_")) continue;
      if (!isConfiguredBreakerName(cb.name, configuredProviders, configuredComboBreakers)) {
        continue;
      }
      providerHealth[cb.name] = {
        state: cb.state,
        failures: cb.failureCount || 0,
        lastFailure: cb.lastFailureTime,
      };
    }

    return NextResponse.json({
      status: "healthy",
      timestamp: new Date().toISOString(),
      system,
      providerHealth,
      localProviders: getAllHealthStatuses(),
      rateLimitStatus,
      lockouts,
      dedup: {
        inflightRequests: getInflightCount(),
      },
      setupComplete: settings?.setupComplete || false,
    });
  } catch (error) {
    console.error("[API] GET /api/monitoring/health error:", error);
    return NextResponse.json({ status: "error", error: "Health check failed" }, { status: 500 });
  }
}

/**
 * DELETE /api/monitoring/health — Reset all circuit breakers
 *
 * Resets all provider circuit breakers to CLOSED state,
 * clearing failure counts and persisted state.
 */
export async function DELETE() {
  try {
    const { resetAllCircuitBreakers, getAllCircuitBreakerStatuses } =
      await import("@/shared/utils/circuitBreaker");

    const before = getAllCircuitBreakerStatuses();
    const resetCount = before.length;

    resetAllCircuitBreakers();

    console.log(`[API] DELETE /api/monitoring/health — Reset ${resetCount} circuit breakers`);

    return NextResponse.json({
      success: true,
      message: `Reset ${resetCount} circuit breaker(s) to healthy state`,
      resetCount,
    });
  } catch (error) {
    console.error("[API] DELETE /api/monitoring/health error:", error);
    return NextResponse.json({ error: "Failed to reset circuit breakers" }, { status: 500 });
  }
}
