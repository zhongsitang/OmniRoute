import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-proxy-registry-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const combosDb = await import("../../src/lib/db/combos.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const proxiesDb = await import("../../src/lib/db/proxies.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const proxyConfigRoute = await import("../../src/app/api/settings/proxy/route.ts");
const proxyResolveRoute = await import("../../src/app/api/settings/proxies/resolve/route.ts");

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

test("proxy settings route put replaces registry-backed scope with managed custom proxy", async () => {
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
  assert.equal(assignments.length, 1);
  const assignedProxy = await proxiesDb.getProxyById(assignments[0].proxyId, {
    includeSecrets: true,
  });
  assert.equal(assignedProxy.visibility, "managed");
  assert.equal(assignedProxy.ownerScope, "provider");
  assert.equal(assignedProxy.ownerScopeId, "openai");
});

test("managed proxy updates clear credentials and orphan cleanup follows scope transitions", async () => {
  await resetStorage();

  const sharedProxy = await proxiesDb.createProxy({
    name: "Shared Proxy",
    type: "http",
    host: "shared.local",
    port: 8080,
  });

  await settingsDb.setProxyForLevel("provider", "openai", {
    type: "http",
    host: "managed-initial.local",
    port: 8081,
    username: "alice",
    password: "secret",
  });

  let managedProxy = await proxiesDb.getManagedProxyForScope("provider", "openai", {
    includeSecrets: true,
  });
  assert.ok(managedProxy?.id);
  const firstManagedId = managedProxy.id;
  assert.equal(managedProxy.username, "alice");
  assert.equal(managedProxy.password, "secret");

  await settingsDb.setProxyForLevel("provider", "openai", {
    type: "https",
    host: "managed-updated.local",
    port: 8443,
    username: "",
    password: "",
  });

  managedProxy = await proxiesDb.getManagedProxyForScope("provider", "openai", {
    includeSecrets: true,
  });
  assert.equal(managedProxy.id, firstManagedId);
  assert.equal(managedProxy.host, "managed-updated.local");
  assert.equal(managedProxy.username, "");
  assert.equal(managedProxy.password, "");

  await proxiesDb.setSharedProxyForScope("provider", "openai", sharedProxy.id);

  const sharedAssignment = await proxiesDb.getProxyAssignmentForScope("provider", "openai", {
    includeSecrets: true,
  });
  assert.equal(sharedAssignment.proxyId, sharedProxy.id);
  assert.equal(await proxiesDb.getProxyById(firstManagedId, { includeSecrets: true }), null);

  await settingsDb.setProxyForLevel("provider", "openai", {
    type: "http",
    host: "managed-final.local",
    port: 8082,
  });

  const recreatedManaged = await proxiesDb.getManagedProxyForScope("provider", "openai", {
    includeSecrets: true,
  });
  assert.ok(recreatedManaged?.id);
  assert.notEqual(recreatedManaged.id, sharedProxy.id);

  await proxiesDb.clearProxyForScope("provider", "openai");

  assert.equal(
    await proxiesDb.getProxyAssignmentForScope("provider", "openai", { includeSecrets: true }),
    null
  );
  assert.equal(await proxiesDb.getProxyById(recreatedManaged.id, { includeSecrets: true }), null);
  assert.ok(await proxiesDb.getProxyById(sharedProxy.id, { includeSecrets: true }));
});

test("registry combo assignment participates in connection resolution", async () => {
  await resetStorage();

  const conn = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "combo-registry",
    apiKey: "sk-test-combo",
  });

  const combo = await combosDb.createCombo({
    name: "combo-registry",
    strategy: "priority",
    models: ["openai/gpt-4.1"],
    config: {},
  });

  const comboProxy = await proxiesDb.createProxy({
    name: "Combo Proxy",
    type: "http",
    host: "combo-registry.local",
    port: 8080,
  });

  await proxiesDb.assignProxyToScope("combo", combo.id, comboProxy.id);

  const withoutComboContext = await settingsDb.resolveProxyForConnection(conn.id);
  assert.equal(withoutComboContext.level, "direct");
  assert.equal(withoutComboContext.proxy, null);

  const resolved = await settingsDb.resolveProxyForConnection(conn.id, {
    comboName: combo.name,
  });
  assert.equal(resolved.level, "combo");
  assert.equal(resolved.source, "registry");
  assert.equal(resolved.proxy.host, "combo-registry.local");
});

test("proxy resolve route returns inherited and direct managed state", async () => {
  await resetStorage();

  const conn = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "resolve-state",
    apiKey: "sk-test-resolve",
  });

  const globalProxy = await proxiesDb.createProxy({
    name: "Global Resolve Proxy",
    type: "http",
    host: "global-resolve.local",
    port: 8080,
  });

  await proxiesDb.assignProxyToScope("global", null, globalProxy.id);

  const inheritedRes = await proxyResolveRoute.GET(
    new Request(`http://localhost/api/settings/proxies/resolve?scope=key&scopeId=${conn.id}`)
  );
  assert.equal(inheritedRes.status, 200);
  const inheritedPayload = await inheritedRes.json();
  assert.equal(inheritedPayload.assignment, null);
  assert.equal(inheritedPayload.effective.level, "global");
  assert.equal(inheritedPayload.inheritedFrom.level, "global");
  assert.equal(inheritedPayload.proxyId, globalProxy.id);

  const customRes = await proxyConfigRoute.PUT(
    new Request("http://localhost/api/settings/proxy", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        level: "key",
        id: conn.id,
        proxy: {
          type: "http",
          host: "managed-account.local",
          port: "8080",
          username: "alice",
          password: "secret",
        },
      }),
    })
  );
  assert.equal(customRes.status, 200);

  const directRes = await proxyResolveRoute.GET(
    new Request(`http://localhost/api/settings/proxies/resolve?scope=key&scopeId=${conn.id}`)
  );
  assert.equal(directRes.status, 200);
  const directPayload = await directRes.json();
  assert.equal(directPayload.assignment.visibility, "managed");
  assert.equal(directPayload.assignment.proxy.host, "managed-account.local");
  assert.equal(directPayload.effective.level, "account");
  assert.equal(directPayload.inheritedFrom, null);
});

test("legacy proxy config migration imports global/provider/key assignments", async () => {
  await resetStorage();

  const conn = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "legacy-import",
    apiKey: "sk-test-legacy",
  });

  const db = core.getDbInstance();
  const insertLegacy = db.prepare(
    "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('proxyConfig', ?, ?)"
  );
  insertLegacy.run(
    "global",
    JSON.stringify({ type: "http", host: "global.local", port: 8080, username: "", password: "" })
  );
  insertLegacy.run(
    "providers",
    JSON.stringify({
      openai: {
        type: "https",
        host: "provider-legacy.local",
        port: 443,
        username: "",
        password: "",
      },
    })
  );
  insertLegacy.run(
    "keys",
    JSON.stringify({
      [conn.id]: {
        type: "http",
        host: "account-legacy.local",
        port: 8082,
        username: "",
        password: "",
      },
    })
  );

  const result = await proxiesDb.migrateLegacyProxyConfigToRegistry();
  assert.equal(result.skipped, false);
  assert.equal(result.migrated >= 3, true);

  const resolved = await settingsDb.resolveProxyForConnection(conn.id);
  assert.equal(resolved.level, "account");
  assert.equal(resolved.source, "registry");
  assert.equal(resolved.proxy.host, "account-legacy.local");

  const raw = await settingsDb.getProxyConfig();
  assert.equal(raw.global, null);
  assert.deepEqual(raw.providers, {});
  assert.deepEqual(raw.keys, {});
});

test("proxy settings route scoped PUT with null proxy clears assignment", async () => {
  await resetStorage();

  const createRes = await proxyConfigRoute.PUT(
    new Request("http://localhost/api/settings/proxy", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        level: "provider",
        id: "openai",
        proxy: {
          type: "http",
          host: "clear-me.local",
          port: "8080",
        },
      }),
    })
  );
  assert.equal(createRes.status, 200);

  const clearRes = await proxyConfigRoute.PUT(
    new Request("http://localhost/api/settings/proxy", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        level: "provider",
        id: "openai",
        proxy: null,
      }),
    })
  );
  assert.equal(clearRes.status, 200);

  const providerRes = await proxyConfigRoute.GET(
    new Request("http://localhost/api/settings/proxy?level=provider&id=openai")
  );
  const providerPayload = await providerRes.json();
  assert.equal(providerPayload.proxy, null);
});

test("proxy resolve route rejects invalid scope values", async () => {
  await resetStorage();

  const invalidRes = await proxyResolveRoute.GET(
    new Request("http://localhost/api/settings/proxies/resolve?scope=typo&scopeId=abc")
  );
  assert.equal(invalidRes.status, 400);
});
