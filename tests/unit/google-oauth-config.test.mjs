import assert from "node:assert/strict";
import test from "node:test";

const GOOGLE_OAUTH_ENV_KEYS = [
  "GEMINI_OAUTH_CLIENT_ID",
  "GEMINI_OAUTH_CLIENT_SECRET",
  "GEMINI_CLI_OAUTH_CLIENT_ID",
  "GEMINI_CLI_OAUTH_CLIENT_SECRET",
];

function snapshotEnv(keys) {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (typeof value === "string") {
      process.env[key] = value;
    } else {
      delete process.env[key];
    }
  }
}

async function importFresh(modulePath) {
  const url = new URL(modulePath, import.meta.url);
  url.searchParams.set("test", `${Date.now()}-${Math.random()}`);
  return import(url.href);
}

test("generateLegacyProviders keeps default client secret only for gemini-cli", async () => {
  const envSnapshot = snapshotEnv(GOOGLE_OAUTH_ENV_KEYS);
  try {
    for (const key of GOOGLE_OAUTH_ENV_KEYS) delete process.env[key];

    const { generateLegacyProviders } = await import("../../open-sse/config/providerRegistry.ts");
    const providers = generateLegacyProviders();

    assert.equal(
      providers.gemini.clientSecret,
      undefined,
      "gemini should not expose a built-in default OAuth client secret"
    );
    assert.equal(
      providers["gemini-cli"].clientSecret,
      "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",
      "gemini-cli should keep the built-in default OAuth client secret"
    );
  } finally {
    restoreEnv(envSnapshot);
  }
});

test("GEMINI_CONFIG prefers gemini-cli env overrides", async () => {
  const envSnapshot = snapshotEnv(GOOGLE_OAUTH_ENV_KEYS);
  try {
    process.env.GEMINI_OAUTH_CLIENT_ID = "legacy-google-id";
    process.env.GEMINI_OAUTH_CLIENT_SECRET = "legacy-google-secret";
    process.env.GEMINI_CLI_OAUTH_CLIENT_ID = "gemini-cli-id";
    process.env.GEMINI_CLI_OAUTH_CLIENT_SECRET = "gemini-cli-secret";

    const { GEMINI_CONFIG } = await importFresh("../../src/lib/oauth/constants/oauth.ts");

    assert.equal(GEMINI_CONFIG.clientId, "gemini-cli-id");
    assert.equal(GEMINI_CONFIG.clientSecret, "gemini-cli-secret");
  } finally {
    restoreEnv(envSnapshot);
  }
});

test("refreshGoogleToken omits client_secret when none is configured", async () => {
  const { refreshGoogleToken } = await import("../../open-sse/services/tokenRefresh.ts");
  const originalFetch = global.fetch;
  let capturedBody = "";

  global.fetch = async (_url, options = {}) => {
    capturedBody = options.body?.toString() || "";
    return {
      ok: false,
      status: 400,
      text: async () => "missing secret",
    };
  };

  try {
    const result = await refreshGoogleToken("refresh-token", "client-id", undefined, null);
    assert.equal(result, null);
  } finally {
    global.fetch = originalFetch;
  }

  assert.match(capturedBody, /grant_type=refresh_token/);
  assert.match(capturedBody, /refresh_token=refresh-token/);
  assert.match(capturedBody, /client_id=client-id/);
  assert.ok(
    !capturedBody.includes("client_secret="),
    "client_secret should be omitted when not configured"
  );
});
