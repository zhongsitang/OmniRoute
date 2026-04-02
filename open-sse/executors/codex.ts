import { BaseExecutor } from "./base.ts";
import { CODEX_DEFAULT_INSTRUCTIONS } from "../config/codexInstructions.ts";
import { PROVIDERS } from "../config/constants.ts";
import { refreshCodexToken } from "../services/tokenRefresh.ts";
import { CODEX_FAST_SERVICE_TIER } from "@/lib/usage/serviceTier";

// Ordered list of effort levels from lowest to highest
const EFFORT_ORDER = ["none", "low", "medium", "high", "xhigh"] as const;
type EffortLevel = (typeof EFFORT_ORDER)[number];

type CodexServiceTierMode = "passthrough" | "override";

export interface CodexServiceTierConfig {
  mode: CodexServiceTierMode;
  value: string;
}

const DEFAULT_CODEX_SERVICE_TIER_CONFIG: CodexServiceTierConfig = {
  mode: "passthrough",
  value: CODEX_FAST_SERVICE_TIER,
};

let defaultCodexServiceTierConfig: CodexServiceTierConfig = {
  ...DEFAULT_CODEX_SERVICE_TIER_CONFIG,
};

function normalizeNativeResponsesInputItem(item: unknown): unknown {
  if (typeof item === "string") {
    return {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: item }],
    };
  }

  if (!item || typeof item !== "object") return item;

  if ("type" in item || "role" in item) {
    return "type" in item ? item : { type: "message", ...(item as Record<string, unknown>) };
  }

  if ("text" in item && typeof item.text === "string") {
    return {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: item.text }],
    };
  }

  return item;
}

function normalizeNativeResponsesInput(body: Record<string, unknown>): void {
  if (typeof body.input === "string") {
    body.input = [normalizeNativeResponsesInputItem(body.input)];
    return;
  }

  if (Array.isArray(body.input)) {
    body.input = body.input.map(normalizeNativeResponsesInputItem);
    return;
  }

  if (body.input && typeof body.input === "object") {
    body.input = [normalizeNativeResponsesInputItem(body.input)];
  }
}

function getResponsesSubpath(endpointPath: unknown): string | null {
  const normalizedEndpoint = String(endpointPath || "").replace(/\/+$/, "");
  const match = normalizedEndpoint.match(/(?:^|\/)responses(?:(\/.*))?$/i);
  if (!match) return null;
  return match[1] || "";
}

function isCompactResponsesEndpoint(endpointPath: unknown): boolean {
  return getResponsesSubpath(endpointPath)?.toLowerCase() === "/compact";
}

function normalizeConfiguredServiceTierValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

export function normalizeCodexServiceTierConfig(value: unknown): CodexServiceTierConfig {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;

    const rawMode = typeof record.mode === "string" ? record.mode.trim().toLowerCase() : "";
    const normalizedMode: CodexServiceTierMode =
      rawMode === "override" ? "override" : "passthrough";
    const normalizedValue =
      normalizeConfiguredServiceTierValue(record.value) ?? DEFAULT_CODEX_SERVICE_TIER_CONFIG.value;

    return {
      mode: normalizedMode,
      value: normalizedValue,
    };
  }

  return { ...DEFAULT_CODEX_SERVICE_TIER_CONFIG };
}

export function setCodexServiceTierConfig(value: unknown): CodexServiceTierConfig {
  const normalized = normalizeCodexServiceTierConfig(value);
  defaultCodexServiceTierConfig = normalized;
  return normalized;
}

export function getCodexServiceTierConfig(): CodexServiceTierConfig {
  return { ...defaultCodexServiceTierConfig };
}

/**
 * Backward-compatible wrapper for older callers.
 * Prefer `setCodexServiceTierConfig({ mode, value })` for new code.
 */
export function setDefaultFastServiceTierEnabled(enabled: boolean): void {
  setCodexServiceTierConfig({
    mode: enabled ? "override" : "passthrough",
    value: CODEX_FAST_SERVICE_TIER,
  });
}

/**
 * Maximum reasoning effort allowed per Codex model.
 * Models not listed here default to "xhigh" (unrestricted).
 * Update this table when Codex releases new models with different caps.
 */
const MAX_EFFORT_BY_MODEL: Record<string, EffortLevel> = {
  "gpt-5.3-codex": "xhigh",
  "gpt-5.2-codex": "xhigh",
  "gpt-5.1-codex-max": "xhigh",
  "gpt-5-mini": "high",
  "gpt-5.1-mini": "high",
  "gpt-4.1-mini": "high",
};

/**
 * Clamp reasoning effort to the model's maximum allowed level.
 * Returns the original value if within limits, or the cap if it exceeds it.
 */
function clampEffort(model: string, requested: string): string {
  const max: EffortLevel = MAX_EFFORT_BY_MODEL[model] ?? "xhigh";
  const reqIdx = EFFORT_ORDER.indexOf(requested as EffortLevel);
  const maxIdx = EFFORT_ORDER.indexOf(max);
  if (reqIdx > maxIdx) {
    console.debug(`[Codex] clampEffort: "${requested}" → "${max}" (model: ${model})`);
    return max;
  }
  return requested;
}

/**
 * Codex Executor - handles OpenAI Codex API (Responses API format)
 * Automatically injects default instructions if missing.
 * IMPORTANT: Includes chatgpt-account-id header for workspace binding.
 */
export class CodexExecutor extends BaseExecutor {
  constructor() {
    super("codex", PROVIDERS.codex);
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    void model;
    void stream;
    void urlIndex;

    const responsesSubpath = getResponsesSubpath(credentials?.requestEndpointPath);
    if (responsesSubpath !== null) {
      const baseUrl = String(this.config.baseUrl || "").replace(/\/$/, "");
      if (baseUrl.endsWith("/responses")) {
        return `${baseUrl}${responsesSubpath}`;
      }
      return `${baseUrl}/responses${responsesSubpath}`;
    }

    return super.buildUrl(model, stream, urlIndex, credentials);
  }

  /**
   * Codex Responses endpoint is SSE-first.
   * Always request event-stream from upstream, even when client requested stream=false.
   * Includes chatgpt-account-id header for strict workspace binding.
   */
  buildHeaders(credentials, stream = true) {
    const isCompactRequest = isCompactResponsesEndpoint(credentials?.requestEndpointPath);
    const headers = super.buildHeaders(credentials, isCompactRequest ? false : true);

    // Add workspace binding header if workspaceId is persisted
    const workspaceId = credentials?.providerSpecificData?.workspaceId;
    if (workspaceId) {
      headers["chatgpt-account-id"] = workspaceId;
    }

    return headers;
  }

  /**
   * Refresh Codex OAuth credentials when a 401 is received.
   * OpenAI uses rotating (one-time-use) refresh tokens — if the token was already
   * consumed by a concurrent refresh, this returns null to signal re-auth is needed.
   *
   * Fixes #251: After a server restart/upgrade, previously cached access tokens may
   * have expired or become invalid. chatCore.ts calls this on 401; previously the
   * base class returned null causing the request to fail instead of refreshing.
   */
  async refreshCredentials(credentials, log) {
    if (!credentials?.refreshToken) {
      log?.warn?.("TOKEN_REFRESH", "Codex: no refresh token available, re-authentication required");
      return null;
    }
    const result = await refreshCodexToken(credentials.refreshToken, log);
    if (!result || result.error) {
      log?.warn?.(
        "TOKEN_REFRESH",
        `Codex: token refresh failed${result?.error ? ` (${result.error})` : ""} — re-authentication required`
      );
      return null;
    }
    return result;
  }

  /**
   * Transform request before sending - inject default instructions if missing
   */
  transformRequest(model, body, stream, credentials) {
    const nativeCodexPassthrough = body?._nativeCodexPassthrough === true;
    const isCompactRequest = isCompactResponsesEndpoint(credentials?.requestEndpointPath);

    // Codex /responses rejects stream=false, but /responses/compact rejects the stream field entirely.
    if (isCompactRequest) {
      delete body.stream;
      delete body.stream_options;
    } else {
      body.stream = true;
    }
    delete body._nativeCodexPassthrough;

    if (defaultCodexServiceTierConfig.mode === "override") {
      body.service_tier = defaultCodexServiceTierConfig.value;
    }

    // Codex /responses passthrough still needs a system prompt because upstream
    // rejects requests that omit instructions entirely.
    if (typeof body.instructions !== "string" || body.instructions.trim() === "") {
      body.instructions = CODEX_DEFAULT_INSTRUCTIONS;
    }

    // Codex requires store=false even for native /responses payloads.
    body.store = false;

    if (nativeCodexPassthrough) {
      normalizeNativeResponsesInput(body);
      return body;
    }

    // Extract thinking level from model name suffix
    // e.g., gpt-5.3-codex-high → high, gpt-5.3-codex → medium (default)
    const effortLevels = ["none", "low", "medium", "high", "xhigh"];
    let modelEffort: string | null = null;
    // Track the clean model name (suffix stripped) for clamp lookup
    let cleanModel = model;
    for (const level of effortLevels) {
      if (model.endsWith(`-${level}`)) {
        modelEffort = level;
        // Strip suffix from model name for actual API call
        body.model = body.model.replace(`-${level}`, "");
        cleanModel = body.model;
        break;
      }
    }

    // Priority: explicit reasoning.effort > reasoning_effort param > model suffix > default (medium)
    if (!body.reasoning) {
      const rawEffort = body.reasoning_effort || modelEffort || "medium";
      // Clamp effort to the model's maximum allowed level (feature-07)
      const effort = clampEffort(cleanModel, rawEffort);
      body.reasoning = { effort };
    } else if (body.reasoning.effort) {
      // Also clamp if reasoning object was provided directly
      body.reasoning.effort = clampEffort(cleanModel, body.reasoning.effort);
    }
    delete body.reasoning_effort;

    // Remove unsupported parameters for Codex API
    delete body.temperature;
    delete body.top_p;
    delete body.frequency_penalty;
    delete body.presence_penalty;
    delete body.logprobs;
    delete body.top_logprobs;
    delete body.n;
    delete body.seed;
    delete body.max_tokens;
    delete body.user; // Cursor sends this but Codex doesn't support it
    delete body.prompt_cache_retention; // Cursor sends this but Codex doesn't support it
    delete body.metadata; // Cursor sends this but Codex doesn't support it
    delete body.stream_options; // Cursor sends this but Codex doesn't support it
    delete body.safety_identifier; // Droid CLI sends this but Codex doesn't support it

    return body;
  }
}
