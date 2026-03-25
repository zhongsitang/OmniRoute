import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-proxy-registry-flow-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const proxyFacadeRoute = await import("../../src/app/api/settings/proxy/route.ts");
const proxySettingsRoute = await import("../../src/app/api/settings/proxies/route.ts");
const proxyAssignmentsRoute =
  await import("../../src/app/api/settings/proxies/assignments/route.ts");
const proxyBulkRoute = await import("../../src/app/api/settings/proxies/bulk-assign/route.ts");
const proxyHealthRoute = await import("../../src/app/api/settings/proxies/health/route.ts");
const proxyResolveRoute = await import("../../src/app/api/settings/proxies/resolve/route.ts");
const proxyLogger = await import("../../src/lib/proxyLogger.ts");

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.after(async () => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("integration: settings proxy registry rejects socks5 writes when socks5 is disabled", async () => {
  await resetStorage();

  const originalEnableSocks5 = process.env.ENABLE_SOCKS5_PROXY;
  delete process.env.ENABLE_SOCKS5_PROXY;

  try {
    const createRes = await proxySettingsRoute.POST(
      new Request("http://localhost/api/settings/proxies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Disabled Socks Proxy",
          type: "socks5",
          host: "socks-disabled.local",
          port: 1080,
        }),
      })
    );
    assert.equal(createRes.status, 400);

    const httpCreateRes = await proxySettingsRoute.POST(
      new Request("http://localhost/api/settings/proxies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "HTTP Proxy",
          type: "http",
          host: "http-only.local",
          port: 8080,
        }),
      })
    );
    assert.equal(httpCreateRes.status, 201);
    const created = await httpCreateRes.json();

    const patchRes = await proxySettingsRoute.PATCH(
      new Request("http://localhost/api/settings/proxies", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: created.id,
          type: "socks5",
        }),
      })
    );
    assert.equal(patchRes.status, 400);
  } finally {
    if (originalEnableSocks5 === undefined) {
      delete process.env.ENABLE_SOCKS5_PROXY;
    } else {
      process.env.ENABLE_SOCKS5_PROXY = originalEnableSocks5;
    }
  }
});

test("integration: proxy registry full flow works and enforces safe delete", async () => {
  await resetStorage();

  const connection = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "proxy-flow-account",
    apiKey: "sk-flow-test",
  });

  const createRes = await proxySettingsRoute.POST(
    new Request("http://localhost/api/settings/proxies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Flow Proxy",
        type: "http",
        host: "flow.local",
        port: 8080,
      }),
    })
  );
  assert.equal(createRes.status, 201);
  const createdProxy = await createRes.json();
  assert.ok(createdProxy.id);

  const assignRes = await proxyAssignmentsRoute.PUT(
    new Request("http://localhost/api/settings/proxies/assignments", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: "account",
        scopeId: connection.id,
        proxyId: createdProxy.id,
      }),
    })
  );
  assert.equal(assignRes.status, 200);

  const resolveRes = await proxyAssignmentsRoute.GET(
    new Request(
      `http://localhost/api/settings/proxies/assignments?resolveConnectionId=${connection.id}`
    )
  );
  assert.equal(resolveRes.status, 200);
  const resolved = await resolveRes.json();
  assert.equal(resolved.level, "account");
  assert.equal(resolved.source, "registry");
  assert.equal(resolved.proxy.host, "flow.local");

  const bulkRes = await proxyBulkRoute.PUT(
    new Request("http://localhost/api/settings/proxies/bulk-assign", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: "provider",
        scopeIds: ["openai", "anthropic"],
        proxyId: createdProxy.id,
      }),
    })
  );
  assert.equal(bulkRes.status, 200);
  const bulkPayload = await bulkRes.json();
  assert.equal(bulkPayload.updated, 2);
  assert.equal(bulkPayload.failed.length, 0);

  proxyLogger.logProxyEvent({
    status: "success",
    proxy: { type: "http", host: "flow.local", port: 8080 },
    latencyMs: 90,
    level: "provider",
    levelId: "openai",
    provider: "openai",
  });
  proxyLogger.logProxyEvent({
    status: "error",
    proxy: { type: "http", host: "flow.local", port: 8080 },
    latencyMs: 240,
    level: "provider",
    levelId: "openai",
    provider: "openai",
  });

  const healthRes = await proxyHealthRoute.GET(
    new Request("http://localhost/api/settings/proxies/health?hours=24")
  );
  assert.equal(healthRes.status, 200);
  const healthPayload = await healthRes.json();
  const row = healthPayload.items.find((item) => item.proxyId === createdProxy.id);
  assert.ok(row);
  assert.equal(row.totalRequests >= 2, true);
  assert.equal(row.errorCount >= 1, true);

  const deleteConflictRes = await proxySettingsRoute.DELETE(
    new Request(`http://localhost/api/settings/proxies?id=${createdProxy.id}`, {
      method: "DELETE",
    })
  );
  assert.equal(deleteConflictRes.status, 409);
  const deleteConflict = await deleteConflictRes.json();
  assert.equal(deleteConflict.error.type, "conflict");
  assert.equal(typeof deleteConflict.requestId, "string");
  assert.equal(deleteConflict.requestId.length > 0, true);

  const clearAccountAssignment = await proxyAssignmentsRoute.PUT(
    new Request("http://localhost/api/settings/proxies/assignments", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: "account",
        scopeId: connection.id,
        proxyId: null,
      }),
    })
  );
  assert.equal(clearAccountAssignment.status, 200);

  const clearProviderBulk = await proxyBulkRoute.PUT(
    new Request("http://localhost/api/settings/proxies/bulk-assign", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: "provider",
        scopeIds: ["openai", "anthropic"],
        proxyId: null,
      }),
    })
  );
  assert.equal(clearProviderBulk.status, 200);

  const deleteOkRes = await proxySettingsRoute.DELETE(
    new Request(`http://localhost/api/settings/proxies?id=${createdProxy.id}`, {
      method: "DELETE",
    })
  );
  assert.equal(deleteOkRes.status, 200);
  const deleteOkPayload = await deleteOkRes.json();
  assert.equal(deleteOkPayload.success, true);
});

test("integration: managed proxies stay out of default picker list and resolve route exposes scope state", async () => {
  await resetStorage();

  const connection = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "managed-list-flow",
    apiKey: "sk-flow-managed",
  });

  const sharedCreateRes = await proxySettingsRoute.POST(
    new Request("http://localhost/api/settings/proxies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Shared Picker Proxy",
        type: "http",
        host: "shared-picker.local",
        port: 8080,
      }),
    })
  );
  assert.equal(sharedCreateRes.status, 201);
  const sharedProxy = await sharedCreateRes.json();

  const managedWriteRes = await proxyFacadeRoute.PUT(
    new Request("http://localhost/api/settings/proxy", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        level: "key",
        id: connection.id,
        proxy: {
          type: "https",
          host: "managed-picker.local",
          port: "8443",
          username: "agent",
          password: "secret",
        },
      }),
    })
  );
  assert.equal(managedWriteRes.status, 200);

  const defaultListRes = await proxySettingsRoute.GET(
    new Request("http://localhost/api/settings/proxies")
  );
  assert.equal(defaultListRes.status, 200);
  const defaultList = await defaultListRes.json();
  assert.deepEqual(
    defaultList.items.map((item) => item.id),
    [sharedProxy.id]
  );

  const fullListRes = await proxySettingsRoute.GET(
    new Request("http://localhost/api/settings/proxies?includeManaged=1")
  );
  assert.equal(fullListRes.status, 200);
  const fullList = await fullListRes.json();
  assert.equal(fullList.items.length, 2);
  assert.equal(
    fullList.items.some((item) => item.visibility === "managed"),
    true
  );

  const resolveRes = await proxyResolveRoute.GET(
    new Request(`http://localhost/api/settings/proxies/resolve?scope=key&scopeId=${connection.id}`)
  );
  assert.equal(resolveRes.status, 200);
  const resolvePayload = await resolveRes.json();
  assert.equal(resolvePayload.assignment.visibility, "managed");
  assert.equal(resolvePayload.assignment.proxy.host, "managed-picker.local");
  assert.equal(resolvePayload.effective.level, "account");
  assert.equal(resolvePayload.inheritedFrom, null);
});
