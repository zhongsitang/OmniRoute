import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const providerLimitUtils =
  await import("../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.tsx");
const { default: Badge } = await import("../../src/shared/components/Badge.tsx");

test("normalizePlanTier maps Plus plans to the shared secondary badge variant", () => {
  const tier = providerLimitUtils.normalizePlanTier("ChatGPT Plus");

  assert.equal(tier.key, "plus");
  assert.equal(tier.label, "Plus");
  assert.equal(tier.variant, "secondary");
});

test("Badge secondary variant renders a pill with a dot", () => {
  const html = renderToStaticMarkup(
    React.createElement(Badge, { variant: "secondary", size: "sm", dot: true }, "Plus")
  );

  assert.ok(html.includes("rounded-full"));
  assert.ok(html.includes("border-black/10"));
  assert.ok(html.includes("text-text-main"));
  assert.ok(html.includes("size-1.5"));
  assert.ok(html.includes("Plus"));
});
