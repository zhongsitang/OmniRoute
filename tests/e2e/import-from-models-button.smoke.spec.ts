import { expect, test } from "@playwright/test";

type SourceModel = {
  id?: string;
  name?: string;
  model?: string;
  display_name?: string;
};

type ProviderModelsPayload = {
  models?: Array<{ id?: string; name?: string }>;
};

type AliasesPayload = {
  aliases?: Record<string, string>;
};

const baseUrl = process.env.OMNIROUTE_TEST_BASE_URL;
const providerId = process.env.OMNIROUTE_TEST_PROVIDER_ID;
const connectionId = process.env.OMNIROUTE_TEST_CONNECTION_ID;
const aliasPrefix = process.env.OMNIROUTE_TEST_ALIAS_PREFIX;
const modelId = process.env.OMNIROUTE_TEST_MODEL_ID;

const isConfigured = !!(baseUrl && providerId && connectionId && aliasPrefix && modelId);

function getAlias() {
  return `${aliasPrefix}-${modelId}`;
}

async function getImportState(request) {
  const [aliasesRes, providerModelsRes] = await Promise.all([
    request.get(`${baseUrl}/api/models/alias`),
    request.get(`${baseUrl}/api/provider-models?provider=${encodeURIComponent(providerId || "")}`),
  ]);

  expect(aliasesRes.ok()).toBeTruthy();
  expect(providerModelsRes.ok()).toBeTruthy();

  const aliasesPayload = (await aliasesRes.json()) as AliasesPayload;
  const providerModelsPayload = (await providerModelsRes.json()) as ProviderModelsPayload;
  const fullModel = `${providerId}/${modelId}`;

  return {
    aliasPresent: aliasesPayload.aliases?.[getAlias()] === fullModel,
    modelPresent:
      providerModelsPayload.models?.some((model) => (model.id || model.name) === modelId) || false,
  };
}

async function restoreImportState(request, modelName: string) {
  const state = await getImportState(request);
  const fullModel = `${providerId}/${modelId}`;

  if (!state.modelPresent) {
    const addResponse = await request.post(`${baseUrl}/api/provider-models`, {
      data: {
        provider: providerId,
        modelId,
        modelName,
        source: "imported",
      },
    });
    expect(addResponse.ok()).toBeTruthy();
  }

  if (!state.aliasPresent) {
    const aliasResponse = await request.put(`${baseUrl}/api/models/alias`, {
      data: {
        model: fullModel,
        alias: getAlias(),
      },
    });
    expect(aliasResponse.ok()).toBeTruthy();
  }
}

test("Import from /models button reimports a missing compatible model", async ({
  page,
  request,
}) => {
  test.skip(
    !isConfigured,
    "Requires OMNIROUTE_TEST_BASE_URL, OMNIROUTE_TEST_PROVIDER_ID, OMNIROUTE_TEST_CONNECTION_ID, OMNIROUTE_TEST_ALIAS_PREFIX, and OMNIROUTE_TEST_MODEL_ID."
  );

  const requireLoginRes = await request.get(`${baseUrl}/api/settings/require-login`);
  expect(requireLoginRes.ok()).toBeTruthy();
  const requireLoginPayload = (await requireLoginRes.json()) as { requireLogin?: boolean };
  test.skip(
    requireLoginPayload.requireLogin,
    "Configured environment requires login; this smoke test needs public dashboard access."
  );

  const modelsRes = await request.get(`${baseUrl}/api/providers/${connectionId}/models`);
  expect(modelsRes.ok()).toBeTruthy();
  const modelsPayload = (await modelsRes.json()) as { models?: SourceModel[] };
  const sourceModel = modelsPayload.models?.find(
    (model) => (model.id || model.name || model.model) === modelId
  );
  expect(sourceModel).toBeTruthy();

  const modelName = sourceModel?.display_name || sourceModel?.name || modelId || "";
  const deleteAliasUrl = `${baseUrl}/api/models/alias?alias=${encodeURIComponent(getAlias())}`;
  const deleteModelUrl = `${baseUrl}/api/provider-models?provider=${encodeURIComponent(providerId || "")}&model=${encodeURIComponent(modelId || "")}`;

  try {
    const deleteAliasRes = await request.delete(deleteAliasUrl);
    expect([200, 404].includes(deleteAliasRes.status())).toBeTruthy();

    const deleteModelRes = await request.delete(deleteModelUrl);
    expect([200, 404].includes(deleteModelRes.status())).toBeTruthy();

    await expect
      .poll(async () => {
        const state = await getImportState(request);
        return `${state.modelPresent}:${state.aliasPresent}`;
      })
      .toBe("false:false");

    await page.goto(`${baseUrl}/dashboard/providers/${providerId}`);
    await page.waitForLoadState("networkidle");

    const redirectedToLogin = page.url().includes("/login");
    test.skip(redirectedToLogin, "Configured environment redirected to /login.");

    const importButton = page.getByRole("button", {
      name: /Import from \/models|从 \/models 导入/,
    });
    await expect(importButton).toBeVisible({ timeout: 20000 });
    await importButton.click();

    await expect
      .poll(
        async () => {
          const state = await getImportState(request);
          return `${state.modelPresent}:${state.aliasPresent}`;
        },
        {
          timeout: 30000,
          message: `Expected ${modelId} to be restored by the Import from /models button`,
        }
      )
      .toBe("true:true");
  } finally {
    await restoreImportState(request, modelName);
  }
});
