import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveOAuthRedirectUri,
  shouldUseLocalCodexCallbackServer,
  shouldUseManualOAuthFallback,
} from "../../src/shared/utils/oauthRedirect.ts";

test("Codex uses localhost:1455 only on true localhost", () => {
  assert.equal(shouldUseLocalCodexCallbackServer("codex", "localhost"), true);
  assert.equal(shouldUseLocalCodexCallbackServer("codex", "127.0.0.1"), true);
  assert.equal(shouldUseLocalCodexCallbackServer("codex", "192.168.16.77"), false);

  assert.equal(
    resolveOAuthRedirectUri({
      provider: "codex",
      hostname: "localhost",
      origin: "http://localhost:20128",
      protocol: "http:",
      port: "20128",
    }),
    "http://localhost:1455/auth/callback"
  );

  assert.equal(
    resolveOAuthRedirectUri({
      provider: "codex",
      hostname: "192.168.16.77",
      origin: "http://192.168.16.77:20130",
      protocol: "http:",
      port: "20130",
    }),
    "http://localhost:1455/auth/callback"
  );
});

test("Remote Codex callback requires manual paste because redirect stays on localhost", () => {
  const redirectUri = resolveOAuthRedirectUri({
    provider: "codex",
    hostname: "192.168.16.77",
    origin: "http://192.168.16.77:20130",
    protocol: "http:",
    port: "20130",
  });

  assert.equal(redirectUri, "http://localhost:1455/auth/callback");
  assert.equal(shouldUseManualOAuthFallback(redirectUri, "http://192.168.16.77:20130"), true);
});

test("Google remote callbacks still require manual paste because they stay on localhost", () => {
  const redirectUri = resolveOAuthRedirectUri({
    provider: "gemini-cli",
    hostname: "192.168.16.77",
    origin: "http://192.168.16.77:20130",
    protocol: "http:",
    port: "20130",
  });

  assert.equal(redirectUri, "http://localhost:20130/callback");
  assert.equal(shouldUseManualOAuthFallback(redirectUri, "http://192.168.16.77:20130"), true);
});
