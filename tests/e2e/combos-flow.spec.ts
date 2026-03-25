import { expect, test } from "@playwright/test";

type ComboStub = {
  id: string;
  name: string;
  strategy: string;
  models: unknown[];
  config: Record<string, unknown>;
  isActive: boolean;
};

type ComboCreatePayload = {
  name?: string;
  strategy?: string;
  models?: unknown[];
  config?: Record<string, unknown>;
};

test.describe("Combos flow", () => {
  test("applies template, creates combo, and runs quick test CTA", async ({ page }) => {
    const state: {
      combos: ComboStub[];
      nextId: number;
      comboTestRequests: number;
    } = {
      combos: [],
      nextId: 1,
      comboTestRequests: 0,
    };

    await page.route("**/api/combos/test", async (route) => {
      state.comboTestRequests += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          resolvedBy: "openai/qa-test-model",
          results: [{ model: "openai/qa-test-model", status: "ok", latencyMs: 42 }],
        }),
      });
    });

    await page.route("**/api/combos/metrics", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ metrics: {} }),
      });
    });

    await page.route("**/api/settings/proxy", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ combos: {} }),
      });
    });

    await page.route("**/api/providers", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          connections: [{ id: "conn-openai", provider: "openai", testStatus: "active" }],
        }),
      });
    });

    await page.route("**/api/provider-nodes", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ nodes: [] }),
      });
    });

    await page.route("**/api/models/alias", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ aliases: {} }),
      });
    });

    await page.route("**/api/provider-models", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          models: {
            openai: [{ id: "qa-test-model", name: "QA Test Model" }],
          },
        }),
      });
    });

    await page.route("**/api/pricing", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          openai: {
            "qa-test-model": {
              input: 0.01,
              output: 0.02,
            },
          },
        }),
      });
    });

    await page.route("**/api/combos", async (route) => {
      const method = route.request().method();
      if (method === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ combos: state.combos }),
        });
        return;
      }

      if (method === "POST") {
        const payloadRaw = route.request().postDataJSON();
        const payload =
          payloadRaw && typeof payloadRaw === "object" ? (payloadRaw as ComboCreatePayload) : {};
        const comboId = `combo-${state.nextId++}`;
        const createdCombo = {
          id: comboId,
          name: payload.name || comboId,
          strategy: payload.strategy || "priority",
          models: payload.models || [],
          config: payload.config || {},
          isActive: true,
        };
        state.combos.push(createdCombo);

        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ combo: createdCombo }),
        });
        return;
      }

      await route.fulfill({
        status: 405,
        contentType: "application/json",
        body: JSON.stringify({ error: "Method not allowed in test stub" }),
      });
    });

    await page.goto("/dashboard/combos");
    await page.waitForLoadState("networkidle");

    const redirectedToLogin = page.url().includes("/login");
    test.skip(redirectedToLogin, "Authentication enabled without a login fixture.");

    await page
      .getByRole("button", { name: /create combo|criar combo/i })
      .first()
      .click();

    const comboDialog = page.getByRole("dialog").first();
    await expect(comboDialog).toBeVisible();
    const comboCreateButton = comboDialog
      .getByRole("button", { name: /create combo|criar combo/i })
      .last();
    const readinessPanel = comboDialog.locator('[data-testid="combo-readiness-panel"]');
    const saveBlockers = comboDialog.locator('[data-testid="combo-save-blockers"]');

    await expect(readinessPanel).toBeVisible();
    await expect(saveBlockers).toBeVisible();
    await expect(comboCreateButton).toBeDisabled();
    const applyRecommendationsButton = comboDialog
      .getByRole("button", { name: /apply recommendations|aplicar recomendações/i })
      .first();

    await expect(applyRecommendationsButton).toBeVisible();
    await comboDialog.locator('[data-testid="strategy-option-weighted"]').click();
    await expect(comboDialog.locator('[data-testid="strategy-change-nudge"]')).toBeVisible();
    await comboDialog.locator('[data-testid="strategy-option-priority"]').click();
    await expect(comboDialog.locator('[data-testid="strategy-change-nudge"]')).toBeVisible();
    await applyRecommendationsButton.click();

    await comboDialog
      .getByRole("button", { name: /high availability|alta disponibilidade/i })
      .click();
    await comboDialog.getByRole("button", { name: /add model|adicionar modelo/i }).click();

    const modelDialog = page.getByRole("dialog").last();
    await expect(modelDialog.getByRole("button", { name: /qa test model/i })).toBeVisible();
    await modelDialog.getByRole("button", { name: /qa test model/i }).click();
    await expect(saveBlockers).toHaveCount(0);
    await expect(comboCreateButton).toBeEnabled();

    await comboCreateButton.click();
    await expect(comboDialog).toBeHidden();

    const quickTestButton = page.getByRole("button", { name: /test now|testar agora/i });
    await expect(quickTestButton).toBeVisible();
    await quickTestButton.click();
    const testDialog = page.getByRole("dialog").last();
    await testDialog.getByRole("button", { name: "Test now", exact: true }).click();

    await expect
      .poll(() => state.comboTestRequests, {
        message: "Expected the quick test CTA to hit /api/combos/test once",
      })
      .toBe(1);

    const testResultsModal = page.getByRole("dialog").last();
    await expect(testResultsModal).toContainText(/qa-test-model/i);
  });

  test("saving a combo proxy refreshes the combo card badge without page reload", async ({
    page,
  }) => {
    const state: {
      combos: ComboStub[];
      sharedProxies: Array<{
        id: string;
        name: string;
        type: string;
        host: string;
        port: number;
        status: string;
      }>;
      assignedProxyId: string | null;
      proxyConfigFetches: number;
    } = {
      combos: [
        {
          id: "combo-proxy-1",
          name: "combo-proxy-1",
          strategy: "priority",
          models: ["openai/qa-test-model"],
          config: {},
          isActive: true,
        },
      ],
      sharedProxies: [
        {
          id: "combo-shared-proxy",
          name: "Combo Shared Proxy",
          type: "http",
          host: "combo.proxy.local",
          port: 8080,
          status: "active",
        },
      ],
      assignedProxyId: null,
      proxyConfigFetches: 0,
    };

    const getCurrentProxy = () =>
      state.sharedProxies.find((proxy) => proxy.id === state.assignedProxyId) || null;

    await page.route("**/api/combos/metrics", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ metrics: {} }),
      });
    });

    await page.route("**/api/providers", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          connections: [{ id: "conn-openai", provider: "openai", testStatus: "active" }],
        }),
      });
    });

    await page.route("**/api/provider-nodes", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ nodes: [] }),
      });
    });

    await page.route("**/api/settings/proxy", async (route) => {
      state.proxyConfigFetches += 1;
      const currentProxy = getCurrentProxy();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          global: null,
          providers: {},
          keys: {},
          combos: currentProxy
            ? {
                "combo-proxy-1": {
                  type: currentProxy.type,
                  host: currentProxy.host,
                  port: currentProxy.port,
                  username: "",
                  password: "",
                },
              }
            : {},
        }),
      });
    });

    await page.route("**/api/settings/proxies/resolve?*", async (route) => {
      const proxy = getCurrentProxy();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          scope: "combo",
          scopeId: "combo-proxy-1",
          assignment: proxy
            ? {
                id: 1,
                proxyId: proxy.id,
                scope: "combo",
                scopeId: "combo-proxy-1",
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                proxy: {
                  type: proxy.type,
                  host: proxy.host,
                  port: proxy.port,
                  username: "",
                  password: "",
                },
                visibility: "shared",
                status: proxy.status,
              }
            : null,
          effective: proxy
            ? {
                level: "combo",
                levelId: "combo-proxy-1",
                source: "registry",
                proxyId: proxy.id,
                visibility: "shared",
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
          visibility: proxy ? "shared" : null,
          status: proxy?.status || null,
        }),
      });
    });

    await page.route("**/api/settings/proxies/assignments", async (route) => {
      if (route.request().method() !== "PUT") {
        await route.fulfill({
          status: 405,
          contentType: "application/json",
          body: JSON.stringify({ error: "Method not allowed in test stub" }),
        });
        return;
      }

      const payload = route.request().postDataJSON() as { proxyId?: string | null };
      state.assignedProxyId = payload.proxyId || null;

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, assignment: { proxyId: state.assignedProxyId } }),
      });
    });

    await page.route("**/api/settings/proxies", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items: state.sharedProxies, total: state.sharedProxies.length }),
      });
    });

    await page.route("**/api/combos", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ combos: state.combos }),
      });
    });

    await page.goto("/dashboard/combos");
    await page.waitForLoadState("networkidle");

    const redirectedToLogin = page.url().includes("/login");
    test.skip(redirectedToLogin, "Authentication enabled without a login fixture.");

    const comboCard = page.locator("div", { hasText: "combo-proxy-1" }).first();
    await expect(comboCard).toBeVisible();
    await expect(comboCard.getByTitle("Proxy configured")).toHaveCount(0);

    await comboCard.getByTitle("Proxy configuration").click();
    const dialog = page.getByRole("dialog").last();
    await dialog.getByRole("combobox").selectOption("combo-shared-proxy");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();

    await expect
      .poll(() => state.proxyConfigFetches, {
        message: "Expected combos page to refetch effective proxy state after save",
      })
      .toBeGreaterThan(1);
    await expect(comboCard.getByTitle("Proxy configured")).toBeVisible();
  });
});
