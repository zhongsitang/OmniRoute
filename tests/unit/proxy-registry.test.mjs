import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-proxy-registry-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const proxiesDb = await import("../../src/lib/db/proxies.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const proxyConfigRoute = await import("../../src/app/api/settings/proxy/route.ts");

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.after(async () => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("proxy registry blocks delete when proxy is still assigned", async () => {
  await resetStorage();

  const created = await proxiesDb.createProxy({
    name: "Delete Safety Proxy",
    type: "http",
    host: "127.0.0.1",
    port: 8080,
  });

  assert.ok(created?.id);
  await proxiesDb.assignProxyToScope("provider", "openai", created.id);

  await assert.rejects(
    async () => proxiesDb.deleteProxyById(created.id),
    (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.code, "proxy_in_use");
      return true;
    }
  );
});

test("registry assignment takes precedence over legacy proxy config", async () => {
  await resetStorage();

  const conn = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "registry-precedence",
    apiKey: "sk-test",
  });

  await settingsDb.setProxyForLevel("key", conn.id, {
    type: "http",
    host: "legacy-key.local",
    port: 8080,
  });

  const providerProxy = await proxiesDb.createProxy({
    name: "Provider Proxy",
    type: "https",
    host: "provider.local",
    port: 443,
  });
  const accountProxy = await proxiesDb.createProxy({
    name: "Account Proxy",
    type: "http",
    host: "account.local",
    port: 8081,
  });

  await proxiesDb.assignProxyToScope("provider", "openai", providerProxy.id);
  await proxiesDb.assignProxyToScope("account", conn.id, accountProxy.id);

  const resolved = await settingsDb.resolveProxyForConnection(conn.id);
  assert.equal(resolved.level, "account");
  assert.equal(resolved.source, "registry");
  assert.equal(resolved.proxy.host, "account.local");
});

test("proxy settings route returns registry-backed global and provider proxies", async () => {
  await resetStorage();

  const globalProxy = await proxiesDb.createProxy({
    name: "Global Registry Proxy",
    type: "http",
    host: "global-registry.local",
    port: 8080,
  });
  const providerProxy = await proxiesDb.createProxy({
    name: "Provider Registry Proxy",
    type: "https",
    host: "provider-registry.local",
    port: 443,
  });

  await proxiesDb.assignProxyToScope("global", null, globalProxy.id);
  await proxiesDb.assignProxyToScope("provider", "openai", providerProxy.id);

  const globalRes = await proxyConfigRoute.GET(
    new Request("http://localhost/api/settings/proxy?level=global")
  );
  assert.equal(globalRes.status, 200);
  const globalPayload = await globalRes.json();
  assert.equal(globalPayload.proxy.host, "global-registry.local");

  const providerRes = await proxyConfigRoute.GET(
    new Request("http://localhost/api/settings/proxy?level=provider&id=openai")
  );
  assert.equal(providerRes.status, 200);
  const providerPayload = await providerRes.json();
  assert.equal(providerPayload.proxy.host, "provider-registry.local");

  const configRes = await proxyConfigRoute.GET(new Request("http://localhost/api/settings/proxy"));
  assert.equal(configRes.status, 200);
  const configPayload = await configRes.json();
  assert.equal(configPayload.global.host, "global-registry.local");
  assert.equal(configPayload.providers.openai.host, "provider-registry.local");
});

test("proxy settings route delete clears registry-backed scope", async () => {
  await resetStorage();

  const providerProxy = await proxiesDb.createProxy({
    name: "Provider Registry Proxy",
    type: "https",
    host: "provider-registry.local",
    port: 443,
  });

  await proxiesDb.assignProxyToScope("provider", "openai", providerProxy.id);

  const deleteRes = await proxyConfigRoute.DELETE(
    new Request("http://localhost/api/settings/proxy?level=provider&id=openai")
  );
  assert.equal(deleteRes.status, 200);

  const providerRes = await proxyConfigRoute.GET(
    new Request("http://localhost/api/settings/proxy?level=provider&id=openai")
  );
  assert.equal(providerRes.status, 200);
  const providerPayload = await providerRes.json();
  assert.equal(providerPayload.proxy, null);
});

test("proxy settings route put replaces registry-backed scope with custom proxy", async () => {
  await resetStorage();

  const providerProxy = await proxiesDb.createProxy({
    name: "Provider Registry Proxy",
    type: "https",
    host: "provider-registry.local",
    port: 443,
  });

  await proxiesDb.assignProxyToScope("provider", "openai", providerProxy.id);

  const updateRes = await proxyConfigRoute.PUT(
    new Request("http://localhost/api/settings/proxy", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        level: "provider",
        id: "openai",
        proxy: {
          type: "http",
          host: "custom-provider.local",
          port: "8080",
        },
      }),
    })
  );
  assert.equal(updateRes.status, 200);

  const providerRes = await proxyConfigRoute.GET(
    new Request("http://localhost/api/settings/proxy?level=provider&id=openai")
  );
  assert.equal(providerRes.status, 200);
  const providerPayload = await providerRes.json();
  assert.equal(providerPayload.proxy.host, "custom-provider.local");

  const assignments = await proxiesDb.getProxyAssignments({ scope: "provider" });
  assert.equal(assignments.length, 0);
});

test("legacy proxy config migration imports global/provider/key assignments", async () => {
  await resetStorage();

  const conn = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "legacy-import",
    apiKey: "sk-test-legacy",
  });

  await settingsDb.setProxyForLevel("global", null, {
    type: "http",
    host: "global.local",
    port: 8080,
  });
  await settingsDb.setProxyForLevel("provider", "openai", {
    type: "https",
    host: "provider-legacy.local",
    port: 443,
  });
  await settingsDb.setProxyForLevel("key", conn.id, {
    type: "http",
    host: "account-legacy.local",
    port: 8082,
  });

  const result = await proxiesDb.migrateLegacyProxyConfigToRegistry();
  assert.equal(result.skipped, false);
  assert.equal(result.migrated >= 3, true);

  const resolved = await settingsDb.resolveProxyForConnection(conn.id);
  assert.equal(resolved.level, "account");
  assert.equal(resolved.source, "registry");
  assert.equal(resolved.proxy.host, "account-legacy.local");
});
