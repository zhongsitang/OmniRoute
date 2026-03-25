/**
 * db/settings.js — Settings, pricing, and proxy config.
 */

import { getDbInstance } from "./core";
import { backupDbFile } from "./backup";
import { PROVIDER_ID_TO_ALIAS } from "@omniroute/open-sse/config/providerModels.ts";
import { invalidateDbCache } from "./readCache";
import {
  getProxyAssignments,
  listProxies,
  resolveProxyForConnectionFromRegistry,
  resolveProxyForScopeFromRegistry,
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

type RegistryProxyScope = "global" | "provider" | "account" | "combo";

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

function normalizeRegistryProxyScope(level: string): RegistryProxyScope {
  const value = String(level || "").toLowerCase();
  if (value === "provider") return "provider";
  if (value === "combo") return "combo";
  if (value === "key" || value === "account") return "account";
  return "global";
}

function clearRegistryProxyAssignment(level: string, id: string | null) {
  const scope = normalizeRegistryProxyScope(level);
  const scopeId = scope === "global" ? "__global__" : id;
  const db = getDbInstance();
  db.prepare("DELETE FROM proxy_assignments WHERE scope = ? AND scope_id IS ?").run(scope, scopeId);
}

function clearRegistryAssignmentsForConfig(config: Record<string, unknown>) {
  if (config.global !== undefined) {
    clearRegistryProxyAssignment("global", null);
  }

  for (const [mapKey, level] of [
    ["providers", "provider"],
    ["combos", "combo"],
    ["keys", "key"],
  ] as const) {
    const value = config[mapKey];
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    for (const id of Object.keys(value)) {
      clearRegistryProxyAssignment(level, id);
    }
  }
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
const ALIAS_TO_PROVIDER_ID = Object.entries(PROVIDER_ID_TO_ALIAS).reduce(
  (acc, [providerId, alias]) => {
    if (alias) acc[alias] = providerId;
    acc[providerId] = providerId;
    return acc;
  },
  {} as Record<string, string>
);

function resolveProviderAliasOrId(providerOrAlias: string): string {
  if (typeof providerOrAlias !== "string") return providerOrAlias;
  return ALIAS_TO_PROVIDER_ID[providerOrAlias] || providerOrAlias;
}

function getComboModelProvider(modelEntry: unknown): string | null {
  const record = toRecord(modelEntry);
  if (typeof record.provider === "string") {
    return resolveProviderAliasOrId(record.provider);
  }

  const modelValue =
    typeof modelEntry === "string"
      ? modelEntry
      : typeof record.model === "string"
        ? record.model
        : null;

  if (!modelValue) return null;

  const [providerOrAlias] = modelValue.split("/", 1);
  if (!providerOrAlias) return null;
  return resolveProviderAliasOrId(providerOrAlias);
}

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

  if (migrated) {
    const insert = db.prepare(
      "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('proxyConfig', ?, ?)"
    );
    if (raw.global !== undefined) insert.run("global", JSON.stringify(raw.global));
    if (raw.providers) insert.run("providers", JSON.stringify(raw.providers));
  }

  return raw;
}

export async function getEffectiveProxyConfig() {
  const effective = cloneProxyConfig(await getProxyConfig());
  const [assignments, proxies] = await Promise.all([
    getProxyAssignments(),
    listProxies({ includeSecrets: true }),
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
  const config = await getEffectiveProxyConfig();
  if (level === "global") return config.global || null;
  const map = toProxyMap(config[level + "s"] || config[level] || {});
  return (id ? map[id] : null) || null;
}

export async function setProxyForLevel(level: string, id: string | null, proxy: ProxyValue) {
  const db = getDbInstance();
  const config = await getProxyConfig();
  clearRegistryProxyAssignment(level, id);

  if (level === "global") {
    config.global = proxy || null;
    db.prepare(
      "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('proxyConfig', 'global', ?)"
    ).run(JSON.stringify(config.global));
  } else {
    const mapKey = level + "s";
    const map = toProxyMap(config[mapKey] || {});
    if (proxy && id) {
      map[id] = proxy;
    } else {
      if (id) delete map[id];
    }
    config[mapKey] = map;
    db.prepare(
      "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('proxyConfig', ?, ?)"
    ).run(mapKey, JSON.stringify(map));
  }

  backupDbFile("pre-write");
  return getEffectiveProxyConfig();
}

export async function deleteProxyForLevel(level: string, id: string | null) {
  return setProxyForLevel(level, id, null);
}

export async function resolveProxyForConnection(connectionId: string) {
  const registryResolved = await resolveProxyForConnectionFromRegistry(connectionId);
  if (registryResolved?.proxy) {
    return registryResolved;
  }

  const config = await getProxyConfig();

  if (connectionId && config.keys?.[connectionId]) {
    return { proxy: config.keys[connectionId], level: "key", levelId: connectionId };
  }

  const db = getDbInstance();
  const connection = db
    .prepare("SELECT provider FROM provider_connections WHERE id = ?")
    .get(connectionId);

  if (connection) {
    const connectionRecord = toRecord(connection);
    const provider =
      typeof connectionRecord.provider === "string" ? connectionRecord.provider : null;
    if (config.combos && Object.keys(config.combos).length > 0) {
      const combos = db.prepare("SELECT id, data FROM combos").all();
      for (const comboRow of combos) {
        const comboRecord = toRecord(comboRow);
        const comboId = typeof comboRecord.id === "string" ? comboRecord.id : null;
        if (comboId && config.combos[comboId]) {
          try {
            const comboRaw = typeof comboRecord.data === "string" ? comboRecord.data : null;
            if (!comboRaw) continue;
            const combo = toRecord(JSON.parse(comboRaw));
            const comboModels = Array.isArray(combo.models) ? combo.models : [];
            const usesProvider = comboModels.some(
              (entry) => getComboModelProvider(entry) === provider
            );
            if (usesProvider) {
              return { proxy: config.combos[comboId], level: "combo", levelId: comboId };
            }
          } catch {
            // Ignore malformed combo records during proxy resolution.
          }
        }
      }
    }

    if (provider && config.providers?.[provider]) {
      return {
        proxy: config.providers[provider],
        level: "provider",
        levelId: provider,
      };
    }
  }

  if (config.global) {
    return { proxy: config.global, level: "global", levelId: null };
  }

  return { proxy: null, level: "direct", levelId: null };
}

export async function resolveProxyForProviderOperation(options: {
  provider?: string | null;
  connectionId?: string | null;
}) {
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

  // Management-plane operations should not inherit combo routing.
  // Keep them scoped to account -> provider -> global -> direct.
  if (connectionId) {
    const accountRegistryProxy = await resolveProxyForScopeFromRegistry("account", connectionId);
    if (accountRegistryProxy?.proxy) {
      return accountRegistryProxy;
    }
  }

  if (provider) {
    const providerRegistryProxy = await resolveProxyForScopeFromRegistry("provider", provider);
    if (providerRegistryProxy?.proxy) {
      return providerRegistryProxy;
    }
  }

  const globalRegistryProxy = await resolveProxyForScopeFromRegistry("global", null);
  if (globalRegistryProxy?.proxy) {
    return globalRegistryProxy;
  }

  const config = await getProxyConfig();

  if (connectionId && config.keys?.[connectionId]) {
    return {
      proxy: config.keys[connectionId],
      level: "account",
      levelId: connectionId,
      source: "legacy",
    };
  }

  if (provider && config.providers?.[provider]) {
    return {
      proxy: config.providers[provider],
      level: "provider",
      levelId: provider,
      source: "legacy",
    };
  }

  if (config.global) {
    return {
      proxy: config.global,
      level: "global",
      levelId: null,
      source: "legacy",
    };
  }

  return { proxy: null, level: "direct", levelId: null, source: "direct" };
}

export async function setProxyConfig(config: Record<string, unknown>) {
  if (config.level !== undefined) {
    const level = typeof config.level === "string" ? config.level : "global";
    const id = typeof config.id === "string" ? config.id : null;
    const proxy = (config.proxy as ProxyValue) || null;
    return setProxyForLevel(level, id, proxy);
  }

  const db = getDbInstance();
  const current = await getProxyConfig();
  const insert = db.prepare(
    "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('proxyConfig', ?, ?)"
  );

  const tx = db.transaction(() => {
    clearRegistryAssignmentsForConfig(config);
    if (config.global !== undefined) {
      current.global = toProxyValue(config.global);
      insert.run("global", JSON.stringify(current.global));
    }
    for (const mapKey of ["providers", "combos", "keys"]) {
      if (config[mapKey]) {
        const merged = { ...toProxyMap(current[mapKey]), ...toProxyMap(config[mapKey]) };
        for (const [k, v] of Object.entries(merged)) {
          if (!v) delete merged[k];
        }
        current[mapKey] = merged;
        insert.run(mapKey, JSON.stringify(merged));
      }
    }
  });
  tx();

  backupDbFile("pre-write");
  return getEffectiveProxyConfig();
}
