import { expect, test } from "@playwright/test";

type ProxyStub = {
  id: string;
  name: string;
  type: string;
  host: string;
  port: number;
  status: string;
  visibility?: "shared" | "managed";
};

type ConnectionStub = {
  id: string;
  provider: string;
  authType: string;
  name: string;
  testStatus: string;
  isActive: boolean;
  priority: number;
};

function buildResolvePayload(proxy: ProxyStub | null) {
  return {
    scope: "account",
    scopeId: "conn-openai-1",
    assignment: proxy
      ? {
          id: 1,
          proxyId: proxy.id,
          scope: "account",
          scopeId: "conn-openai-1",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          proxy: {
            type: proxy.type,
            host: proxy.host,
            port: proxy.port,
            username: "",
            password: "",
          },
          visibility: proxy.visibility || "shared",
          status: proxy.status,
        }
      : null,
    effective: proxy
      ? {
          level: "account",
          levelId: "conn-openai-1",
          source: "registry",
          proxyId: proxy.id,
          visibility: proxy.visibility || "shared",
          status: proxy.status,
          proxy: {
            type: proxy.type,
            host: proxy.host,
            port: proxy.port,
            username: "",
            password: "",
          },
        }
      : {
          level: "direct",
          levelId: null,
          source: "direct",
          proxyId: null,
          visibility: null,
          status: null,
          proxy: null,
        },
    inheritedFrom: null,
    proxyId: proxy?.id || null,
    visibility: proxy?.visibility || null,
    status: proxy?.status || null,
  };
}

test.describe("Provider connection proxy flow", () => {
  test("saving and switching a shared proxy refreshes the connection badge immediately", async ({
    page,
  }) => {
    const sharedProxies: ProxyStub[] = [
      {
        id: "proxy-shared-a",
        name: "Shared Proxy A",
        type: "http",
        host: "alpha.proxy.local",
        port: 8080,
        status: "active",
        visibility: "shared",
      },
      {
        id: "proxy-shared-b",
        name: "Shared Proxy B",
        type: "https",
        host: "beta.proxy.local",
        port: 8443,
        status: "active",
        visibility: "shared",
      },
    ];

    const connection: ConnectionStub = {
      id: "conn-openai-1",
      provider: "openai",
      authType: "apikey",
      name: "Primary OpenAI",
      testStatus: "active",
      isActive: true,
      priority: 1,
    };

    let assignedProxyId: string | null = null;
    let proxyConfigFetches = 0;

    const currentProxy = () => sharedProxies.find((proxy) => proxy.id === assignedProxyId) || null;

    await page.route("**/api/providers*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ connections: [connection] }),
      });
    });

    await page.route("**/api/provider-nodes*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ nodes: [] }),
      });
    });

    await page.route("**/api/models/alias*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ aliases: {} }),
      });
    });

    await page.route("**/api/provider-models*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ models: [], modelCompatOverrides: [] }),
      });
    });

    await page.route("**/api/settings/proxy*", async (route) => {
      proxyConfigFetches += 1;
      const proxy = currentProxy();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          global: null,
          providers: {},
          combos: {},
          keys: proxy
            ? {
                [connection.id]: {
                  type: proxy.type,
                  host: proxy.host,
                  port: proxy.port,
                  username: "",
                  password: "",
                },
              }
            : {},
        }),
      });
    });

    await page.route("**/api/settings/proxies/resolve?*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(buildResolvePayload(currentProxy())),
      });
    });

    await page.route("**/api/settings/proxies/assignments", async (route) => {
      if (route.request().method() !== "PUT") {
        await route.fulfill({
          status: 405,
          contentType: "application/json",
          body: JSON.stringify({
            error: { message: "Method not allowed", type: "invalid_request" },
          }),
        });
        return;
      }

      const payload = route.request().postDataJSON() as {
        scope?: string;
        scopeId?: string;
        proxyId?: string | null;
      };
      assignedProxyId = payload.proxyId || null;

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          assignment: assignedProxyId
            ? { proxyId: assignedProxyId, scope: payload.scope, scopeId: payload.scopeId }
            : null,
        }),
      });
    });

    await page.route("**/api/settings/proxies", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items: sharedProxies, total: sharedProxies.length }),
      });
    });

    await page.goto("/dashboard/providers/openai");
    await page.waitForLoadState("networkidle");

    const redirectedToLogin = page.url().includes("/login");
    test.skip(redirectedToLogin, "Authentication enabled without a login fixture.");

    await expect(page.getByRole("heading", { name: "Connections" })).toBeVisible({
      timeout: 20000,
    });

    const connectionRow = page
      .getByText(connection.name, { exact: true })
      .locator("xpath=ancestor::div[contains(@class,'group')][1]");
    await expect(connectionRow).toBeVisible();
    await expect(connectionRow).not.toContainText("alpha.proxy.local");

    await connectionRow.getByTitle("Proxy config").click();
    const firstDialog = page.getByRole("dialog").last();
    await firstDialog.getByRole("combobox").selectOption("proxy-shared-a");
    await firstDialog.getByRole("button", { name: "Save", exact: true }).click();

    await expect
      .poll(() => proxyConfigFetches, {
        message: "Expected provider page to refetch effective proxy state after the first save",
      })
      .toBeGreaterThan(1);
    await expect(connectionRow).toContainText("alpha.proxy.local");

    await connectionRow.getByTitle("Proxy config").click();
    const secondDialog = page.getByRole("dialog").last();
    await secondDialog.getByRole("combobox").selectOption("proxy-shared-b");
    await secondDialog.getByRole("button", { name: "Save", exact: true }).click();

    await expect(connectionRow).toContainText("beta.proxy.local");
  });
});
