import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-compatible-usage-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.JWT_SECRET = "x".repeat(32);

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const usageRoute = await import("../../src/app/api/usage/[connectionId]/route.ts");
const usageService = await import("../../open-sse/services/usage.ts");
const providerLimitUtils =
  await import("../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.tsx");
const quotaCache = await import("../../src/domain/quotaCache.ts");

async function settleBackupTasks() {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

async function resetStorage() {
  await settleBackupTasks();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

function restoreFetch(originalFetch) {
  globalThis.fetch = originalFetch;
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  await settleBackupTasks();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("compatible provider daily usage normalizes into balance mode with inferred reset", async () => {
  const originalFetch = globalThis.fetch;
  let seenRequest = null;

  globalThis.fetch = async (url, init = {}) => {
    seenRequest = { url, init };
    return new Response(
      JSON.stringify({
        planName: "Compatible Daily",
        remaining: 18.51495075,
        unit: "USD",
        subscription: {
          daily_limit_usd: 90,
          daily_usage_usd: 71.48504925,
          expires_at: "2026-04-21T02:41:17.964873+08:00",
        },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );
  };

  try {
    const usage = await usageService.getUsageForProvider({
      provider: "openai-compatible-chat-test-node",
      apiKey: "sk_test",
      providerSpecificData: {
        baseUrl: "https://compatible.example/v1/",
      },
    });

    assert.equal(seenRequest.url, "https://compatible.example/v1/usage");
    assert.equal(seenRequest.init.headers.Authorization, "Bearer sk_test");
    assert.equal(usage.usageType, "compatible-balance");
    assert.equal(usage.plan, "Compatible Daily");
    assert.equal(usage.balance.kind, "periodic");
    assert.equal(usage.balance.unit, "USD");
    assert.equal(usage.balance.remaining, 18.51495075);
    assert.equal(usage.balance.used, 71.48504925);
    assert.equal(usage.balance.limit, 90);
    assert.equal(usage.balance.period, "daily");
    assert.equal(usage.balance.expiresAt, "2026-04-20T18:41:17.964Z");
    assert.ok(typeof usage.balance.resetAt === "string");
    assert.ok(new Date(usage.balance.resetAt).getTime() > Date.now());

    const parsed = providerLimitUtils.parseProviderUsageData(
      "openai-compatible-chat-test-node",
      usage
    );
    assert.equal(parsed.mode, "balance");
    assert.equal(parsed.balance.kind, "periodic");
    assert.equal(parsed.balance.limit, 90);
  } finally {
    restoreFetch(originalFetch);
  }
});

test("compatible provider wallet balance prefers balance field and stays out of quota bars", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        balance: 3.83778536,
        remaining: 1.2345,
        planName: "钱包余额",
        unit: "USD",
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );

  try {
    const usage = await usageService.getUsageForProvider({
      provider: "anthropic-compatible-wallet-node",
      apiKey: "sk_wallet",
      providerSpecificData: {
        baseUrl: "https://wallet.example/v1",
      },
    });

    assert.equal(usage.usageType, "compatible-balance");
    assert.equal(usage.balance.kind, "wallet");
    assert.equal(usage.balance.remaining, 3.83778536);
    assert.equal(usage.balance.limit, null);
    assert.equal(usage.balance.used, null);
    assert.equal(usage.balance.period, null);
    assert.equal(usage.balance.resetAt, null);

    const parsed = providerLimitUtils.parseProviderUsageData(
      "anthropic-compatible-wallet-node",
      usage
    );
    assert.equal(parsed.mode, "balance");
    assert.equal(parsed.balance.kind, "wallet");
    assert.equal(parsed.quotas.length, 0);
  } finally {
    restoreFetch(originalFetch);
  }
});

test("compatible provider parser falls back to nested fields for incompatible usage payloads", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        data: {
          account: {
            wallet_balance: "7.654321",
            currency: "USD",
            expires_at: "2026-05-01T00:00:00Z",
          },
          metadata: {
            title: "Leishen Wallet",
          },
        },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );

  try {
    const usage = await usageService.getUsageForProvider({
      provider: "openai-compatible-responses-fallback-node",
      apiKey: "sk_fallback",
      providerSpecificData: {
        baseUrl: "https://fallback.example/openai",
      },
    });

    assert.equal(usage.usageType, "compatible-balance");
    assert.equal(usage.plan, "Leishen Wallet");
    assert.equal(usage.balance.kind, "wallet");
    assert.equal(usage.balance.remaining, 7.654321);
    assert.equal(usage.balance.unit, "USD");
    assert.equal(usage.balance.expiresAt, "2026-05-01T00:00:00.000Z");
  } finally {
    restoreFetch(originalFetch);
  }
});

test("usage route returns compatible api key balance payload", async () => {
  const originalFetch = globalThis.fetch;
  const explicitResetAt = "2026-04-22T00:00:00Z";

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        planName: "Compat Daily Route",
        remaining: 9.5,
        unit: "USD",
        subscription: {
          daily_limit_usd: 20,
          daily_usage_usd: 10.5,
          daily_reset_at: explicitResetAt,
        },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );

  try {
    const connection = await providersDb.createProviderConnection({
      provider: "openai-compatible-chat-route-node",
      authType: "apikey",
      name: "Compat Route",
      apiKey: "sk_route",
      testStatus: "active",
      isActive: true,
      providerSpecificData: {
        baseUrl: "https://route.example/v1",
        nodeName: "Route Node",
        apiType: "chat",
      },
    });

    const response = await usageRoute.GET(
      new Request(`http://localhost:20128/api/usage/${connection.id}`),
      { params: Promise.resolve({ connectionId: connection.id }) }
    );

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.usageType, "compatible-balance");
    assert.equal(payload.balance.kind, "periodic");
    assert.equal(payload.balance.limit, 20);
    assert.equal(payload.balance.used, 10.5);
    assert.equal(
      new Date(payload.balance.resetAt).toISOString(),
      new Date(explicitResetAt).toISOString()
    );

    const cached = quotaCache.getQuotaCache(connection.id);
    assert.ok(cached);
    assert.equal(cached.provider, connection.provider);
    assert.equal(cached.exhausted, false);
    assert.equal(
      new Date(cached.quotas.daily.resetAt).toISOString(),
      new Date(explicitResetAt).toISOString()
    );
  } finally {
    restoreFetch(originalFetch);
  }
});

test("usage route keeps compatible API key connections out of expired token sync on 401", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () =>
    new Response("denied", {
      status: 401,
      headers: { "content-type": "text/plain" },
    });

  try {
    const connection = await providersDb.createProviderConnection({
      provider: "openai-compatible-chat-auth-node",
      authType: "apikey",
      name: "Compat Auth",
      apiKey: "sk_auth",
      testStatus: "active",
      isActive: true,
      providerSpecificData: {
        baseUrl: "https://auth.example/v1",
        nodeName: "Auth Node",
        apiType: "chat",
      },
    });

    const response = await usageRoute.GET(
      new Request(`http://localhost:20128/api/usage/${connection.id}`),
      { params: Promise.resolve({ connectionId: connection.id }) }
    );

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.match(payload.message, /invalid|denied/i);

    const stored = await providersDb.getProviderConnectionById(connection.id);
    assert.equal(stored.testStatus, "active");
    assert.notEqual(stored.lastErrorType, "token_expired");
  } finally {
    restoreFetch(originalFetch);
  }
});

test("usage route still returns unavailable for non-compatible api key providers", async () => {
  const connection = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "OpenAI API Key",
    apiKey: "sk_openai",
    isActive: true,
  });

  const response = await usageRoute.GET(
    new Request(`http://localhost:20128/api/usage/${connection.id}`),
    { params: Promise.resolve({ connectionId: connection.id }) }
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.message, "Usage not available for API key connections");
});

test("unknown plan tiers stay generic instead of echoing raw plan text", () => {
  const tier = providerLimitUtils.normalizePlanTier("钱包余额");
  assert.equal(tier.key, "unknown");
  assert.equal(tier.label, "Unknown");
  assert.equal(tier.raw, "钱包余额");
});

test("compatible balance amounts are formatted to two decimals", () => {
  assert.match(providerLimitUtils.formatBalanceAmount(3.83778536, "USD"), /^\$3[.,]84 USD$/);
  assert.match(providerLimitUtils.formatBalanceAmount(9, "USD"), /^\$9[.,]00 USD$/);
});
