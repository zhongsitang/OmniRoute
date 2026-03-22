import { NextResponse } from "next/server";
import { getProviderConnections, getProviderNodes, getSettings } from "@/lib/localDb";
import { APP_CONFIG } from "@/shared/constants/config";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function toNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isConfiguredBreakerName(
  breakerName: string,
  configuredProviders: Set<string>,
  configuredModelProviders: Set<string>
): boolean {
  if (breakerName.startsWith("combo:")) {
    const modelName = breakerName.slice("combo:".length);
    const providerId = toNonEmptyString(modelName.split("/")[0]);
    return Boolean(providerId && configuredModelProviders.has(providerId));
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

    const [settings, connections, providerNodes] = await Promise.all([
      getSettings(),
      getProviderConnections(),
      getProviderNodes(),
    ]);
    const circuitBreakers = getAllCircuitBreakerStatuses();
    const rateLimitStatus = getAllRateLimitStatus();
    const lockouts = getAllModelLockouts();
    const { getAllHealthStatuses } = await import("@/lib/localHealthCheck");
    const configuredProviders = new Set(
      connections
        .map((connection) => (isRecord(connection) ? toNonEmptyString(connection.provider) : null))
        .filter((provider): provider is string => Boolean(provider))
    );
    const configuredModelProviders = new Set([
      ...configuredProviders,
      ...providerNodes
        .map((node) => (isRecord(node) ? toNonEmptyString(node.prefix) : null))
        .filter((prefix): prefix is string => Boolean(prefix)),
    ]);

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
      if (!isConfiguredBreakerName(cb.name, configuredProviders, configuredModelProviders)) {
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
