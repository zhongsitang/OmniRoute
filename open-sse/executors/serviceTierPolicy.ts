import { CODEX_FAST_SERVICE_TIER } from "@/lib/usage/serviceTier";
import type { ProviderCredentials } from "./base.ts";

export type ServiceTierMode = "passthrough" | "omit" | "priority";

export interface ServiceTierPolicy {
  mode: ServiceTierMode;
}

const DEFAULT_SERVICE_TIER_POLICY: ServiceTierPolicy = {
  mode: "passthrough",
};

let defaultServiceTierPolicy: ServiceTierPolicy = {
  ...DEFAULT_SERVICE_TIER_POLICY,
};

function normalizeMode(value: unknown): ServiceTierMode {
  if (typeof value !== "string") return DEFAULT_SERVICE_TIER_POLICY.mode;

  const normalized = value.trim().toLowerCase();
  if (normalized === "omit" || normalized === "priority") return normalized;
  return DEFAULT_SERVICE_TIER_POLICY.mode;
}

export function normalizeServiceTierPolicy(value: unknown): ServiceTierPolicy {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return {
      mode: normalizeMode(record.mode),
    };
  }

  return { ...DEFAULT_SERVICE_TIER_POLICY };
}

export function setServiceTierPolicy(value: unknown): ServiceTierPolicy {
  const normalized = normalizeServiceTierPolicy(value);
  defaultServiceTierPolicy = normalized;
  return normalized;
}

export function getServiceTierPolicy(): ServiceTierPolicy {
  return { ...defaultServiceTierPolicy };
}

function shouldApplyServiceTierPolicy(
  provider: string,
  credentials: ProviderCredentials | undefined
): boolean {
  if (provider === "codex") return true;
  if (provider === "openai" && credentials?.apiKey) return true;
  return false;
}

export function applyConfiguredServiceTierPolicy(
  provider: string,
  body: unknown,
  credentials?: ProviderCredentials
): void {
  if (!shouldApplyServiceTierPolicy(provider, credentials)) return;
  if (!body || typeof body !== "object" || Array.isArray(body)) return;

  const record = body as Record<string, unknown>;

  switch (defaultServiceTierPolicy.mode) {
    case "omit":
      delete record.service_tier;
      delete record.serviceTier;
      return;
    case "priority":
      delete record.serviceTier;
      record.service_tier = CODEX_FAST_SERVICE_TIER;
      return;
    case "passthrough":
    default:
      return;
  }
}
