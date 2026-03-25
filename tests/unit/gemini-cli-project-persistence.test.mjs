import test from "node:test";
import assert from "node:assert/strict";

const { buildGeminiCliProjectPersistenceUpdates } =
  await import("../../src/sse/services/tokenRefresh.ts");
const { buildGeminiCliProjectPersistenceUpdate } =
  await import("../../src/app/api/providers/[id]/models/route.ts");
const { checkFallbackError } = await import("../../open-sse/services/accountFallback.ts");

test("buildGeminiCliProjectPersistenceUpdates persists top-level projectId from providerSpecificData", () => {
  const updates = buildGeminiCliProjectPersistenceUpdates(
    {
      projectId: null,
      providerSpecificData: { region: "us-central1" },
    },
    {
      accessToken: "new-token",
      providerSpecificData: { projectId: "sincere-wharf-ll9s4" },
    }
  );

  assert.equal(updates.projectId, "sincere-wharf-ll9s4");
  assert.equal(updates.providerSpecificData.projectId, "sincere-wharf-ll9s4");
  assert.equal(updates.providerSpecificData.region, "us-central1");
});

test("buildGeminiCliProjectPersistenceUpdate returns write patch when connection top-level projectId is missing", () => {
  const patch = buildGeminiCliProjectPersistenceUpdate(
    {
      providerSpecificData: { foo: "bar" },
      projectId: null,
    },
    "sincere-wharf-ll9s4"
  );

  assert.deepEqual(patch, {
    projectId: "sincere-wharf-ll9s4",
    providerSpecificData: {
      foo: "bar",
      projectId: "sincere-wharf-ll9s4",
    },
  });
});

test("buildGeminiCliProjectPersistenceUpdate returns null when top-level and providerSpecificData already match", () => {
  const patch = buildGeminiCliProjectPersistenceUpdate(
    {
      projectId: "sincere-wharf-ll9s4",
      providerSpecificData: { projectId: "sincere-wharf-ll9s4" },
    },
    "sincere-wharf-ll9s4"
  );

  assert.equal(patch, null);
});

test("checkFallbackError enables fallback for gemini-cli project-context 400", () => {
  const result = checkFallbackError(
    400,
    "loadCodeAssist failed: cloudaicompanionProject is invalid",
    0,
    null,
    "gemini-cli"
  );

  assert.equal(result.shouldFallback, true);
});

test("checkFallbackError keeps non-gemini 400 behavior unchanged", () => {
  const result = checkFallbackError(400, "project is invalid for this request", 0, null, "groq");

  assert.equal(result.shouldFallback, false);
});
