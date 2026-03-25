import test from "node:test";
import assert from "node:assert/strict";

import { FORMATS } from "../../open-sse/translator/formats.ts";
import { detectFormat } from "../../open-sse/services/provider.ts";
import { GeminiCLIExecutor } from "../../open-sse/executors/gemini-cli.ts";
import { translateRequest } from "../../open-sse/translator/index.ts";
import { resolveNativeGeminiCliModelOverride } from "../../src/sse/handlers/chat.ts";

test("detectFormat identifies wrapped native Gemini CLI requests", () => {
  const format = detectFormat({
    model: "gemini-2.5-flash",
    userAgent: "gemini-cli",
    request: {
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
    },
  });

  assert.equal(format, FORMATS.GEMINI_CLI);
});

test("resolveNativeGeminiCliModelOverride prefers gemini-cli for wrapped bare models", () => {
  const override = resolveNativeGeminiCliModelOverride(
    "gemini-2.5-flash",
    {
      userAgent: "gemini-cli",
      request: {
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
      },
    },
    FORMATS.GEMINI_CLI
  );

  assert.deepEqual(override, {
    provider: "gemini-cli",
    model: "gemini-2.5-flash",
    extendedContext: false,
  });
});

test("resolveNativeGeminiCliModelOverride keeps explicit provider prefixes untouched", () => {
  const override = resolveNativeGeminiCliModelOverride(
    "gemini/gemini-2.5-flash",
    {
      userAgent: "gemini-cli",
      request: {
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
      },
    },
    FORMATS.GEMINI_CLI
  );

  assert.equal(override, null);
});

test("resolveNativeGeminiCliModelOverride ignores non-gemini bare models", () => {
  const override = resolveNativeGeminiCliModelOverride(
    "alias-model",
    {
      userAgent: "gemini-cli",
      request: {
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
      },
    },
    FORMATS.GEMINI_CLI
  );

  assert.equal(override, null);
});

test("GeminiCLIExecutor.transformRequest restores projectId from providerSpecificData", () => {
  const executor = new GeminiCLIExecutor();
  const transformed = executor.transformRequest(
    "gemini-2.5-flash",
    { request: { contents: [{ role: "user", parts: [{ text: "hello" }] }] } },
    false,
    {
      accessToken: "token",
      providerSpecificData: { projectId: "sincere-wharf-ll9s4" },
    }
  );

  assert.equal(transformed.project, "sincere-wharf-ll9s4");
});

test("translateRequest restores cloud code projectId from providerSpecificData", () => {
  const translated = translateRequest(
    FORMATS.OPENAI,
    FORMATS.GEMINI_CLI,
    "gemini-2.5-flash",
    {
      model: "gc/gemini-2.5-flash",
      messages: [{ role: "user", content: "hello" }],
      stream: false,
    },
    false,
    {
      providerSpecificData: { projectId: "sincere-wharf-ll9s4" },
    }
  );

  assert.equal(translated.project, "sincere-wharf-ll9s4");
  assert.equal(translated.userAgent, "gemini-cli");
});
