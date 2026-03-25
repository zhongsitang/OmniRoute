/**
 * db/settings.js — Settings, pricing, and proxy config.
 */

import { getDbInstance } from "./core";
import { backupDbFile } from "./backup";
import { invalidateDbCache } from "./readCache";
import {
  getProxyAssignments,
  getProxyAssignmentForScope,
  clearProxyForScope,
  listProxies,
  resolveProxyScopeStateFromRegistry,
  resolveProxyForConnectionFromRegistry,
  resolveProxyForScopeFromRegistry,
  upsertManagedProxyForScope,
} from "./proxies";

type JsonRecord = Record<string, unknown>;
type PricingModels = Record<string, JsonRecord>;
type PricingByProvider = Record<string, PricingModels>;
type ProxyValue = JsonRecord | string | null;
type ProxyMap = Record<string, ProxyValue>;

interface ProxyConfig {
  global: ProxyValue;
  providers: ProxyMap;
  combos: ProxyMap;
  keys: ProxyMap;
  [key: string]: unknown;
}

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? (value as JsonRecord) : {};
}

function toProxyMap(value: unknown): ProxyMap {
  return value && typeof value === "object" ? (value as ProxyMap) : {};
}

function toProxyValue(value: unknown): ProxyValue {
  if (value === null || typeof value === "string") return value as string | null;
  if (value && typeof value === "object") return value as JsonRecord;
  return null;
}

function cloneProxyConfig(config: ProxyConfig): ProxyConfig {
  return {
    ...DEFAULT_PROXY_CONFIG,
    ...config,
    global: toProxyValue(config.global),
    providers: { ...toProxyMap(config.providers) },
    combos: { ...toProxyMap(config.combos) },
    keys: { ...toProxyMap(config.keys) },
  };
}

function proxyValueFromRegistryRecord(value: unknown): JsonRecord | null {
  const record = toRecord(value);
  const host = typeof record.host === "string" ? record.host : "";
  if (!host) return null;

  return {
    type: typeof record.type === "string" ? record.type : "http",
    host,
    port: Number(record.port) || 0,
    username: typeof record.username === "string" ? record.username : "",
    password: typeof record.password === "string" ? record.password : "",
  };
}

// ──────────────── Settings ────────────────

export async function getSettings() {
  const db = getDbInstance();
  const rows = db.prepare("SELECT key, value FROM key_value WHERE namespace = 'settings'").all();
  const settings: Record<string, unknown> = {
    cloudEnabled: false,
    stickyRoundRobinLimit: 3,
    requireLogin: true,
  };
  for (const row of rows) {
    const record = toRecord(row);
    const key = typeof record.key === "string" ? record.key : null;
    const rawValue = typeof record.value === "string" ? record.value : null;
    if (!key || rawValue === null) continue;
    settings[key] = JSON.parse(rawValue);
  }

  // Auto-complete onboarding for pre-configured deployments (Docker/VM)
  // If INITIAL_PASSWORD is set via env, this is a headless deploy — skip the wizard
  if (!settings.setupComplete && process.env.INITIAL_PASSWORD) {
    settings.setupComplete = true;
    settings.requireLogin = true;
    db.prepare(
      "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('settings', 'setupComplete', 'true')"
    ).run();
    db.prepare(
      "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('settings', 'requireLogin', 'true')"
    ).run();
  }

  return settings;
}

export async function updateSettings(updates: Record<string, unknown>) {
  const db = getDbInstance();
  const insert = db.prepare(
    "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('settings', ?, ?)"
  );
  const tx = db.transaction(() => {
    for (const [key, value] of Object.entries(updates)) {
      insert.run(key, JSON.stringify(value));
    }
  });
  tx();
  backupDbFile("pre-write");
  invalidateDbCache("settings"); // Bust the read cache immediately
  return getSettings();
}

export async function isCloudEnabled() {
  const settings = await getSettings();
  return settings.cloudEnabled === true;
}

// ──────────────── Pricing ────────────────

export async function getPricing() {
  const db = getDbInstance();

  // Layer 1: Hardcoded defaults (lowest priority)
  const { getDefaultPricing } = await import("@/shared/constants/pricing");
  const defaultPricing = getDefaultPricing();

  // Layer 2: Synced external pricing (middle priority)
  const syncedRows = db
    .prepare("SELECT key, value FROM key_value WHERE namespace = 'pricing_synced'")
    .all();
  const syncedPricing: PricingByProvider = {};
  for (const row of syncedRows) {
    const record = toRecord(row);
    const key = typeof record.key === "string" ? record.key : null;
    const rawValue = typeof record.value === "string" ? record.value : null;
    if (!key || rawValue === null) continue;
    syncedPricing[key] = toRecord(JSON.parse(rawValue)) as PricingModels;
  }

  // Layer 3: User overrides (highest priority)
  const rows = db.prepare("SELECT key, value FROM key_value WHERE namespace = 'pricing'").all();
  const userPricing: PricingByProvider = {};
  for (const row of rows) {
    const record = toRecord(row);
    const key = typeof record.key === "string" ? record.key : null;
    const rawValue = typeof record.value === "string" ? record.value : null;
    if (!key || rawValue === null) continue;
    userPricing[key] = toRecord(JSON.parse(rawValue)) as PricingModels;
  }

  // Merge: defaults → synced → user (each layer overrides the previous)
  const mergedPricing: PricingByProvider = {};

  // Start with defaults
  for (const [provider, models] of Object.entries(defaultPricing) as Array<[string, unknown]>) {
    mergedPricing[provider] = { ...(toRecord(models) as PricingModels) };
  }

  // Layer synced then user on top (each higher-priority layer overrides)
  for (const layer of [syncedPricing, userPricing]) {
    for (const [provider, models] of Object.entries(layer)) {
      if (!mergedPricing[provider]) {
        mergedPricing[provider] = { ...models };
      } else {
        for (const [model, pricing] of Object.entries(models)) {
          mergedPricing[provider][model] = mergedPricing[provider][model]
            ? { ...(mergedPricing[provider][model] || {}), ...toRecord(pricing) }
            : pricing;
        }
      }
    }
  }

  return mergedPricing;
}

export async function getPricingForModel(provider: string, model: string) {
  const pricing = await getPricing();
  if (pricing[provider]?.[model]) return pricing[provider][model];

  const { PROVIDER_ID_TO_ALIAS } = await import("@omniroute/open-sse/config/providerModels");
  const alias = PROVIDER_ID_TO_ALIAS[provider];
  if (alias && pricing[alias]) return pricing[alias][model] || null;

  const np = provider?.replace(/-cn$/, "");
  if (np && np !== provider && pricing[np]) return pricing[np][model] || null;

  return null;
}

export async function updatePricing(pricingData: PricingByProvider) {
  const db = getDbInstance();
  const insert = db.prepare(
    "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('pricing', ?, ?)"
  );

  const rows = db.prepare("SELECT key, value FROM key_value WHERE namespace = 'pricing'").all();
  const existing: PricingByProvider = {};
  for (const row of rows) {
    const record = toRecord(row);
    const key = typeof record.key === "string" ? record.key : null;
    const rawValue = typeof record.value === "string" ? record.value : null;
    if (!key || rawValue === null) continue;
    existing[key] = toRecord(JSON.parse(rawValue)) as PricingModels;
  }

  const tx = db.transaction(() => {
    for (const [provider, models] of Object.entries(pricingData)) {
      insert.run(provider, JSON.stringify({ ...(existing[provider] || {}), ...models }));
    }
  });
  tx();
  backupDbFile("pre-write");
  invalidateDbCache("pricing"); // Bust the pricing read cache
  const updated: PricingByProvider = {};
  const allRows = db.prepare("SELECT key, value FROM key_value WHERE namespace = 'pricing'").all();
  for (const row of allRows) {
    const record = toRecord(row);
    const key = typeof record.key === "string" ? record.key : null;
    const rawValue = typeof record.value === "string" ? record.value : null;
    if (!key || rawValue === null) continue;
    updated[key] = toRecord(JSON.parse(rawValue)) as PricingModels;
  }
  return updated;
}

export async function resetPricing(provider: string, model?: string) {
  const db = getDbInstance();

  if (model) {
    const row = db
      .prepare("SELECT value FROM key_value WHERE namespace = 'pricing' AND key = ?")
      .get(provider);
    if (row) {
      const rowRecord = toRecord(row);
      const value = typeof rowRecord.value === "string" ? rowRecord.value : "{}";
      const models = toRecord(JSON.parse(value));
      delete models[model];
      if (Object.keys(models).length === 0) {
        db.prepare("DELETE FROM key_value WHERE namespace = 'pricing' AND key = ?").run(provider);
      } else {
        db.prepare("UPDATE key_value SET value = ? WHERE namespace = 'pricing' AND key = ?").run(
          JSON.stringify(models),
          provider
        );
      }
    }
  } else {
    db.prepare("DELETE FROM key_value WHERE namespace = 'pricing' AND key = ?").run(provider);
  }

  backupDbFile("pre-write");
  const allRows = db.prepare("SELECT key, value FROM key_value WHERE namespace = 'pricing'").all();
  const result: Record<string, unknown> = {};
  for (const row of allRows) {
    const record = toRecord(row);
    const key = typeof record.key === "string" ? record.key : null;
    const rawValue = typeof record.value === "string" ? record.value : null;
    if (!key || rawValue === null) continue;
    result[key] = JSON.parse(rawValue);
  }
  return result;
}

export async function resetAllPricing() {
  const db = getDbInstance();
  db.prepare("DELETE FROM key_value WHERE namespace = 'pricing'").run();
  backupDbFile("pre-write");
  return {};
}

// ──────────────── Proxy Config ────────────────

const DEFAULT_PROXY_CONFIG: ProxyConfig = { global: null, providers: {}, combos: {}, keys: {} };
let proxyNormalizationPromise: Promise<void> | null = null;

function migrateProxyEntry(value: unknown): JsonRecord | null {
  if (!value) return null;
  if (typeof value === "object") {
    const record = toRecord(value);
    if (record.type) return record;
  }
  if (typeof value !== "string") return null;

  try {
    const url = new URL(value);
    return {
      type: url.protocol.replace(":", "") || "http",
      host: url.hostname,
      port:
        url.port ||
        (url.protocol === "socks5:" ? "1080" : url.protocol === "https:" ? "443" : "8080"),
      username: url.username ? decodeURIComponent(url.username) : "",
      password: url.password ? decodeURIComponent(url.password) : "",
    };
  } catch {
    const parts = value.split(":");
    return {
      type: "http",
      host: parts[0] || value,
      port: parts[1] || "8080",
      username: "",
      password: "",
    };
  }
}

export async function getProxyConfig() {
  const db = getDbInstance();
  const rows = db.prepare("SELECT key, value FROM key_value WHERE namespace = 'proxyConfig'").all();

  const raw: ProxyConfig = { ...DEFAULT_PROXY_CONFIG };
  for (const row of rows) {
    const record = toRecord(row);
    const key = typeof record.key === "string" ? record.key : null;
    const rawValue = typeof record.value === "string" ? record.value : null;
    if (!key || rawValue === null) continue;
    raw[key] = JSON.parse(rawValue);
  }

  let migrated = false;
  if (raw.global && typeof raw.global === "string") {
    raw.global = migrateProxyEntry(raw.global);
    migrated = true;
  }
  if (raw.providers) {
    for (const [k, v] of Object.entries(raw.providers)) {
      if (typeof v === "string") {
        raw.providers[k] = migrateProxyEntry(v);
        migrated = true;
      }
    }
  }
  if (raw.combos) {
    for (const [k, v] of Object.entries(raw.combos)) {
      if (typeof v === "string") {
        raw.combos[k] = migrateProxyEntry(v);
        migrated = true;
      }
    }
  }
  if (raw.keys) {
    for (const [k, v] of Object.entries(raw.keys)) {
      if (typeof v === "string") {
        raw.keys[k] = migrateProxyEntry(v);
        migrated = true;
      }
    }
  }

  if (migrated) {
    const insert = db.prepare(
      "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('proxyConfig', ?, ?)"
    );
    if (raw.global !== undefined) insert.run("global", JSON.stringify(raw.global));
    if (raw.providers) insert.run("providers", JSON.stringify(raw.providers));
    if (raw.combos) insert.run("combos", JSON.stringify(raw.combos));
    if (raw.keys) insert.run("keys", JSON.stringify(raw.keys));
  }

  return raw;
}

function levelToScope(level: string) {
  const normalized = String(level || "").toLowerCase();
  if (normalized === "provider") return "provider" as const;
  if (normalized === "combo") return "combo" as const;
  if (normalized === "key" || normalized === "account") return "account" as const;
  return "global" as const;
}

function clearLegacyProxyConfigEntry(
  scope: "global" | "provider" | "combo" | "account",
  scopeId: string | null
) {
  const db = getDbInstance();

  if (scope === "global") {
    db.prepare("DELETE FROM key_value WHERE namespace = 'proxyConfig' AND key = 'global'").run();
    return;
  }

  const mapKey = scope === "provider" ? "providers" : scope === "combo" ? "combos" : "keys";
  const row = db
    .prepare("SELECT value FROM key_value WHERE namespace = 'proxyConfig' AND key = ?")
    .get(mapKey);
  const record = toRecord(row);
  const rawValue = typeof record.value === "string" ? record.value : null;
  if (!rawValue || !scopeId) return;

  let parsed: Record<string, unknown> = {};
  try {
    const json = JSON.parse(rawValue);
    if (json && typeof json === "object" && !Array.isArray(json)) {
      parsed = json as Record<string, unknown>;
    }
  } catch {
    parsed = {};
  }

  if (!Object.prototype.hasOwnProperty.call(parsed, scopeId)) return;
  delete parsed[scopeId];

  if (Object.keys(parsed).length === 0) {
    db.prepare("DELETE FROM key_value WHERE namespace = 'proxyConfig' AND key = ?").run(mapKey);
    return;
  }

  db.prepare(
    "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('proxyConfig', ?, ?)"
  ).run(mapKey, JSON.stringify(parsed));
}

function normalizeProxyPayload(value: ProxyValue): JsonRecord | null {
  const migrated = migrateProxyEntry(value);
  if (!migrated) return null;
  return proxyValueFromRegistryRecord(migrated);
}

async function normalizeLegacyProxyConfigToRegistry() {
  if (proxyNormalizationPromise) {
    await proxyNormalizationPromise;
    return;
  }

  proxyNormalizationPromise = (async () => {
    const raw = await getProxyConfig();

    const applyEntry = async (
      scope: "global" | "provider" | "combo" | "account",
      scopeId: string | null,
      value: unknown
    ) => {
      if (value === undefined) return;

      const existing = await getProxyAssignmentForScope(scope, scopeId, {
        includeSecrets: true,
      });
      if (existing) {
        clearLegacyProxyConfigEntry(scope, scopeId);
        return;
      }

      const normalized = normalizeProxyPayload(value as ProxyValue);
      if (!normalized) return;

      await upsertManagedProxyForScope(scope, scopeId, {
        type: typeof normalized.type === "string" ? normalized.type : "http",
        host: typeof normalized.host === "string" ? normalized.host : "",
        port: Number(normalized.port) || 8080,
        username: typeof normalized.username === "string" ? normalized.username : "",
        password: typeof normalized.password === "string" ? normalized.password : "",
        region: null,
        notes: null,
        status: "active",
      });
      clearLegacyProxyConfigEntry(scope, scopeId);
    };

    await applyEntry("global", null, raw.global);

    for (const [providerId, value] of Object.entries(raw.providers || {})) {
      await applyEntry("provider", providerId, value);
    }
    for (const [comboId, value] of Object.entries(raw.combos || {})) {
      await applyEntry("combo", comboId, value);
    }
    for (const [connectionId, value] of Object.entries(raw.keys || {})) {
      await applyEntry("account", connectionId, value);
    }
  })().finally(() => {
    proxyNormalizationPromise = null;
  });

  await proxyNormalizationPromise;
}

export async function getEffectiveProxyConfig() {
  await normalizeLegacyProxyConfigToRegistry();
  const effective = cloneProxyConfig(DEFAULT_PROXY_CONFIG);
  const [assignments, proxies] = await Promise.all([
    getProxyAssignments(),
    listProxies({ includeSecrets: true, includeManaged: true, includeInactive: false }),
  ]);

  const proxyById = new Map(
    proxies
      .map((proxy) => [proxy.id, proxyValueFromRegistryRecord(proxy)] as const)
      .filter((entry): entry is readonly [string, JsonRecord] => entry[1] !== null)
  );

  for (const assignment of assignments) {
    const proxyValue = proxyById.get(assignment.proxyId);
    if (!proxyValue) continue;

    if (assignment.scope === "global") {
      effective.global = proxyValue;
      continue;
    }

    if (!assignment.scopeId) continue;

    if (assignment.scope === "provider") {
      effective.providers[assignment.scopeId] = proxyValue;
      continue;
    }

    if (assignment.scope === "combo") {
      effective.combos[assignment.scopeId] = proxyValue;
      continue;
    }

    if (assignment.scope === "account") {
      effective.keys[assignment.scopeId] = proxyValue;
    }
  }

  return effective;
}

export async function getProxyForLevel(level: string, id?: string | null) {
  await normalizeLegacyProxyConfigToRegistry();
  const resolved = await resolveProxyForScopeFromRegistry(levelToScope(level), id || null, {
    includeSecrets: true,
  });
  return resolved?.proxy || null;
}

export async function setProxyForLevel(level: string, id: string | null, proxy: ProxyValue) {
  await normalizeLegacyProxyConfigToRegistry();
  const normalized = normalizeProxyPayload(proxy);
  if (!normalized) {
    throw Object.assign(new Error("Invalid proxy configuration"), {
      status: 400,
      type: "invalid_request",
    });
  }

  await upsertManagedProxyForScope(levelToScope(level), id, {
    type: typeof normalized.type === "string" ? normalized.type : "http",
    host: typeof normalized.host === "string" ? normalized.host : "",
    port: Number(normalized.port) || 8080,
    username: typeof normalized.username === "string" ? normalized.username : "",
    password: typeof normalized.password === "string" ? normalized.password : "",
    region: null,
    notes: null,
    status: "active",
  });
  return getEffectiveProxyConfig();
}

export async function deleteProxyForLevel(level: string, id: string | null) {
  await normalizeLegacyProxyConfigToRegistry();
  await clearProxyForScope(levelToScope(level), id);
  return getEffectiveProxyConfig();
}

export async function resolveProxyScopeState(level: string, id: string | null) {
  await normalizeLegacyProxyConfigToRegistry();
  return resolveProxyScopeStateFromRegistry(levelToScope(level), id, {
    includeSecrets: true,
  });
}

export async function resolveProxyForConnection(
  connectionId: string,
  options?: { comboId?: string | null; comboName?: string | null }
) {
  await normalizeLegacyProxyConfigToRegistry();
  const registryResolved = await resolveProxyForConnectionFromRegistry(connectionId, options);
  if (registryResolved?.proxy) {
    return registryResolved;
  }

  return { proxy: null, level: "direct", levelId: null };
}

export async function resolveProxyForProviderOperation(options: {
  provider?: string | null;
  connectionId?: string | null;
}) {
  await normalizeLegacyProxyConfigToRegistry();
  const connectionId =
    typeof options?.connectionId === "string" && options.connectionId.trim().length > 0
      ? options.connectionId.trim()
      : null;

  let provider =
    typeof options?.provider === "string" && options.provider.trim().length > 0
      ? options.provider.trim()
      : null;

  if (!provider && connectionId) {
    const db = getDbInstance();
    const connection = db
      .prepare("SELECT provider FROM provider_connections WHERE id = ?")
      .get(connectionId);
    const connectionRecord = toRecord(connection);
    provider =
      typeof connectionRecord.provider === "string" && connectionRecord.provider.trim().length > 0
        ? connectionRecord.provider
        : null;
  }

  if (connectionId) {
    const accountRegistryProxy = await resolveProxyForScopeFromRegistry("account", connectionId, {
      includeSecrets: true,
    });
    if (accountRegistryProxy?.proxy) {
      return accountRegistryProxy;
    }
  }

  if (provider) {
    const providerRegistryProxy = await resolveProxyForScopeFromRegistry("provider", provider, {
      includeSecrets: true,
    });
    if (providerRegistryProxy?.proxy) {
      return providerRegistryProxy;
    }
  }

  const globalRegistryProxy = await resolveProxyForScopeFromRegistry("global", null, {
    includeSecrets: true,
  });
  if (globalRegistryProxy?.proxy) {
    return globalRegistryProxy;
  }

  return { proxy: null, level: "direct", levelId: null, source: "direct" };
}

export async function setProxyConfig(config: Record<string, unknown>) {
  await normalizeLegacyProxyConfigToRegistry();

  if (config.level !== undefined) {
    const level = typeof config.level === "string" ? config.level : "global";
    const id = typeof config.id === "string" ? config.id : null;
    if (config.proxy === null) {
      await clearProxyForScope(levelToScope(level), id);
      return getEffectiveProxyConfig();
    }
    const proxy = (config.proxy as ProxyValue) || null;
    return setProxyForLevel(level, id, proxy);
  }

  if (Object.prototype.hasOwnProperty.call(config, "global")) {
    if (config.global === null) {
      await clearProxyForScope("global", null);
    } else if (config.global !== undefined) {
      await setProxyForLevel("global", null, config.global as ProxyValue);
    }
  }

  for (const [mapKey, level] of [
    ["providers", "provider"],
    ["combos", "combo"],
    ["keys", "key"],
  ] as const) {
    const value = config[mapKey];
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    for (const [scopeId, proxyValue] of Object.entries(value)) {
      if (proxyValue === null) {
        await clearProxyForScope(levelToScope(level), scopeId);
      } else if (proxyValue !== undefined) {
        await setProxyForLevel(level, scopeId, proxyValue as ProxyValue);
      }
    }
  }

  return getEffectiveProxyConfig();
}
