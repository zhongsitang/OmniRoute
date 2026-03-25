import { randomUUID } from "crypto";
import { PROVIDER_ID_TO_ALIAS } from "@omniroute/open-sse/config/providerModels.ts";
import { getDbInstance } from "./core";
import { backupDbFile } from "./backup";

type JsonRecord = Record<string, unknown>;

export type ProxyScope = "global" | "provider" | "account" | "combo";
export type ProxyVisibility = "shared" | "managed";

interface ProxyRegistryRecord {
  id: string;
  name: string;
  type: string;
  host: string;
  port: number;
  username: string;
  password: string;
  region: string | null;
  notes: string | null;
  status: string;
  visibility: ProxyVisibility;
  ownerScope: ProxyScope | null;
  ownerScopeId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ProxyAssignmentRecord {
  id: number;
  proxyId: string;
  scope: ProxyScope;
  scopeId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ProxyAssignmentWithProxy extends ProxyAssignmentRecord {
  proxy: ProxyRegistryRecord;
  visibility: ProxyVisibility;
  status: string;
}

interface ProxyPayload {
  name: string;
  type: string;
  host: string;
  port: number;
  username?: string;
  password?: string;
  region?: string | null;
  notes?: string | null;
  status?: string;
  visibility?: ProxyVisibility;
  ownerScope?: ProxyScope | null;
  ownerScopeId?: string | null;
}

interface LegacyProxyConfig {
  global?: unknown;
  providers?: Record<string, unknown>;
  combos?: Record<string, unknown>;
  keys?: Record<string, unknown>;
}

interface ResolveProxyOptions {
  includeInactive?: boolean;
  includeSecrets?: boolean;
}

interface AccountProxyResolutionOptions {
  comboId?: string | null;
  comboName?: string | null;
}

interface ProxyConfigObject {
  type: string;
  host: string;
  port: number;
  username: string;
  password: string;
}

interface ResolvedProxyInfo {
  proxy: ProxyConfigObject | null;
  level: ProxyScope | "direct";
  levelId: string | null;
  source: "registry" | "direct";
  proxyId: string | null;
  visibility: ProxyVisibility | null;
  status: string | null;
}

interface ScopeProxyState {
  scope: ProxyScope;
  scopeId: string | null;
  assignment:
    | (ProxyAssignmentRecord & {
        proxy: ProxyConfigObject;
        proxyId: string;
        visibility: ProxyVisibility;
        status: string;
      })
    | null;
  effective: ResolvedProxyInfo;
  inheritedFrom: ResolvedProxyInfo | null;
  proxyId: string | null;
  visibility: ProxyVisibility | null;
  status: string | null;
}

const ALIAS_TO_PROVIDER_ID = Object.entries(PROVIDER_ID_TO_ALIAS).reduce(
  (acc, [providerId, alias]) => {
    if (alias) acc[alias] = providerId;
    acc[providerId] = providerId;
    return acc;
  },
  {} as Record<string, string>
);

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? (value as JsonRecord) : {};
}

function normalizeScope(scope: string): ProxyScope {
  const value = String(scope || "").toLowerCase();
  if (value === "key") return "account";
  if (value === "provider") return "provider";
  if (value === "account") return "account";
  if (value === "combo") return "combo";
  return "global";
}

function normalizeScopeIdForAssignment(scope: ProxyScope, scopeId: string | null): string | null {
  return scope === "global" ? "__global__" : scopeId;
}

function normalizeOwnerScopeId(scope: ProxyScope, scopeId: string | null): string | null {
  return scope === "global" ? null : scopeId;
}

function normalizeVisibility(value: unknown): ProxyVisibility {
  return value === "managed" ? "managed" : "shared";
}

function normalizeStatus(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : "active";
}

function isActiveStatus(status: string | null | undefined): boolean {
  return normalizeStatus(status) === "active";
}

function proxySelectColumns(alias?: string): string {
  const prefix = alias ? `${alias}.` : "";
  return [
    `${prefix}id`,
    `${prefix}name`,
    `${prefix}type`,
    `${prefix}host`,
    `${prefix}port`,
    `${prefix}username`,
    `${prefix}password`,
    `${prefix}region`,
    `${prefix}notes`,
    `${prefix}status`,
    `${prefix}visibility`,
    `${prefix}owner_scope`,
    `${prefix}owner_scope_id`,
    `${prefix}created_at`,
    `${prefix}updated_at`,
  ].join(", ");
}

function mapProxyRow(row: unknown): ProxyRegistryRecord {
  const r = toRecord(row);
  const rawOwnerScope = typeof r.owner_scope === "string" ? r.owner_scope : null;
  const normalizedOwnerScope = rawOwnerScope ? normalizeScope(rawOwnerScope) : null;
  return {
    id: typeof r.id === "string" ? r.id : "",
    name: typeof r.name === "string" ? r.name : "",
    type: typeof r.type === "string" ? r.type : "http",
    host: typeof r.host === "string" ? r.host : "",
    port: Number(r.port) || 0,
    username: typeof r.username === "string" ? r.username : "",
    password: typeof r.password === "string" ? r.password : "",
    region: typeof r.region === "string" ? r.region : null,
    notes: typeof r.notes === "string" ? r.notes : null,
    status: normalizeStatus(r.status),
    visibility: normalizeVisibility(r.visibility),
    ownerScope: normalizedOwnerScope,
    ownerScopeId:
      normalizedOwnerScope === "global"
        ? null
        : typeof r.owner_scope_id === "string"
          ? r.owner_scope_id
          : null,
    createdAt: typeof r.created_at === "string" ? r.created_at : "",
    updatedAt: typeof r.updated_at === "string" ? r.updated_at : "",
  };
}

function mapAssignmentRow(row: unknown): ProxyAssignmentRecord {
  const r = toRecord(row);
  const scope = normalizeScope(typeof r.scope === "string" ? r.scope : "global");
  const rawScopeId = typeof r.scope_id === "string" ? r.scope_id : null;
  return {
    id: Number(r.id) || 0,
    proxyId: typeof r.proxy_id === "string" ? r.proxy_id : "",
    scope,
    scopeId: scope === "global" && rawScopeId === "__global__" ? null : rawScopeId,
    createdAt: typeof r.created_at === "string" ? r.created_at : "",
    updatedAt: typeof r.updated_at === "string" ? r.updated_at : "",
  };
}

function mapAssignmentWithProxyRow(row: unknown): ProxyAssignmentWithProxy | null {
  const r = toRecord(row);
  if (typeof r.assignment_proxy_id !== "string" || typeof r.assignment_id !== "number") return null;
  const assignment = mapAssignmentRow({
    id: r.assignment_id,
    proxy_id: r.assignment_proxy_id,
    scope: r.assignment_scope,
    scope_id: r.assignment_scope_id,
    created_at: r.assignment_created_at,
    updated_at: r.assignment_updated_at,
  });
  const proxy = mapProxyRow(row);
  return {
    ...assignment,
    proxy,
    visibility: proxy.visibility,
    status: proxy.status,
  };
}

function proxyRecordToConfig(proxy: ProxyRegistryRecord): ProxyConfigObject {
  return {
    type: proxy.type,
    host: proxy.host,
    port: proxy.port,
    username: proxy.username || "",
    password: proxy.password || "",
  };
}

function resolvedFromAssignment(assignment: ProxyAssignmentWithProxy): ResolvedProxyInfo {
  return {
    proxy: proxyRecordToConfig(assignment.proxy),
    level: assignment.scope,
    levelId: assignment.scopeId,
    source: "registry",
    proxyId: assignment.proxyId,
    visibility: assignment.visibility,
    status: assignment.status,
  };
}

export function redactProxySecrets(proxy: ProxyRegistryRecord): ProxyRegistryRecord {
  return {
    ...proxy,
    username: proxy.username ? "***" : "",
    password: proxy.password ? "***" : "",
  };
}

function getLegacyProxyConfigMapKey(scope: ProxyScope): "providers" | "combos" | "keys" | null {
  if (scope === "provider") return "providers";
  if (scope === "combo") return "combos";
  if (scope === "account") return "keys";
  return null;
}

function clearLegacyProxyConfigForScope(scope: ProxyScope, scopeId: string | null) {
  const db = getDbInstance();

  if (scope === "global") {
    db.prepare("DELETE FROM key_value WHERE namespace = 'proxyConfig' AND key = 'global'").run();
    return;
  }

  const mapKey = getLegacyProxyConfigMapKey(scope);
  if (!mapKey || !scopeId) return;

  const row = db
    .prepare("SELECT value FROM key_value WHERE namespace = 'proxyConfig' AND key = ?")
    .get(mapKey);
  const record = toRecord(row);
  const rawValue = typeof record.value === "string" ? record.value : null;
  if (!rawValue) return;

  let proxyMap: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(rawValue);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      proxyMap = parsed as Record<string, unknown>;
    }
  } catch {
    proxyMap = {};
  }

  if (!Object.prototype.hasOwnProperty.call(proxyMap, scopeId)) return;
  delete proxyMap[scopeId];

  if (Object.keys(proxyMap).length === 0) {
    db.prepare("DELETE FROM key_value WHERE namespace = 'proxyConfig' AND key = ?").run(mapKey);
    return;
  }

  db.prepare(
    "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('proxyConfig', ?, ?)"
  ).run(mapKey, JSON.stringify(proxyMap));
}

function coerceProxyPayload(
  value: unknown,
  fallbackName: string,
  owner?: { scope: ProxyScope; scopeId: string | null }
): ProxyPayload | null {
  if (!value) return null;

  if (typeof value === "string") {
    try {
      const parsed = new URL(value);
      return {
        name: fallbackName,
        type: parsed.protocol.replace(":", "") || "http",
        host: parsed.hostname,
        port: Number(parsed.port || (parsed.protocol === "https:" ? "443" : "8080")),
        username: parsed.username ? decodeURIComponent(parsed.username) : "",
        password: parsed.password ? decodeURIComponent(parsed.password) : "",
        status: "active",
        visibility: owner ? "managed" : "shared",
        ownerScope: owner?.scope || null,
        ownerScopeId: owner ? normalizeOwnerScopeId(owner.scope, owner.scopeId) : null,
      };
    } catch {
      return null;
    }
  }

  if (typeof value !== "object" || Array.isArray(value)) return null;
  const record = toRecord(value);
  const host = typeof record.host === "string" ? record.host.trim() : "";
  if (!host) return null;

  return {
    name: fallbackName,
    type: typeof record.type === "string" ? record.type : "http",
    host,
    port: Number(record.port) || 8080,
    username: typeof record.username === "string" ? record.username : "",
    password: typeof record.password === "string" ? record.password : "",
    status: "active",
    visibility: owner ? "managed" : "shared",
    ownerScope: owner?.scope || null,
    ownerScopeId: owner ? normalizeOwnerScopeId(owner.scope, owner.scopeId) : null,
  };
}

function buildManagedProxyName(scope: ProxyScope, scopeId: string | null): string {
  const label = scope === "global" ? "global" : scopeId || scope;
  return `Managed ${scope} proxy (${label})`;
}

function isOwnedManagedProxy(
  proxy: ProxyRegistryRecord | null | undefined,
  scope: ProxyScope,
  scopeId: string | null
): boolean {
  if (!proxy || proxy.visibility !== "managed") return false;
  if (proxy.ownerScope !== scope) return false;
  return normalizeOwnerScopeId(scope, scopeId) === proxy.ownerScopeId;
}

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

function createInvalidProxyError(message: string) {
  const error = new Error(message) as Error & { status?: number; type?: string };
  error.status = 400;
  error.type = "invalid_request";
  return error;
}

async function getComboScopeIdForProvider(
  provider: string | null,
  options?: AccountProxyResolutionOptions
): Promise<string | null> {
  if (!provider) return null;
  const comboId =
    typeof options?.comboId === "string" && options.comboId.trim().length > 0
      ? options.comboId.trim()
      : null;
  const comboName =
    typeof options?.comboName === "string" && options.comboName.trim().length > 0
      ? options.comboName.trim()
      : null;
  if (!comboId && !comboName) return null;

  const db = getDbInstance();
  const row = comboId
    ? (db.prepare("SELECT id, data FROM combos WHERE id = ?").get(comboId) as
        | Record<string, unknown>
        | undefined)
    : (db.prepare("SELECT id, data FROM combos WHERE name = ?").get(comboName) as
        | Record<string, unknown>
        | undefined);

  const resolvedComboId = typeof row?.id === "string" ? row.id : null;
  const rawData = typeof row?.data === "string" ? row.data : null;
  if (!resolvedComboId || !rawData) return null;

  try {
    const combo = toRecord(JSON.parse(rawData));
    const comboModels = Array.isArray(combo.models) ? combo.models : [];
    const usesProvider = comboModels.some((entry) => getComboModelProvider(entry) === provider);
    return usesProvider ? resolvedComboId : null;
  } catch {
    // Ignore malformed combo records during proxy resolution.
    return null;
  }
}

function serializeAssignment(
  assignment: ProxyAssignmentWithProxy | null,
  options?: { includeSecrets?: boolean }
) {
  if (!assignment) return null;
  const proxy =
    options?.includeSecrets === true ? assignment.proxy : redactProxySecrets(assignment.proxy);
  return {
    id: assignment.id,
    proxyId: assignment.proxyId,
    scope: assignment.scope,
    scopeId: assignment.scopeId,
    createdAt: assignment.createdAt,
    updatedAt: assignment.updatedAt,
    proxy: proxyRecordToConfig(proxy),
    visibility: assignment.visibility,
    status: assignment.status,
  };
}

export async function listProxies(options?: {
  includeSecrets?: boolean;
  includeManaged?: boolean;
  includeInactive?: boolean;
}) {
  const includeSecrets = options?.includeSecrets === true;
  const includeManaged = options?.includeManaged === true;
  const includeInactive = options?.includeInactive === true;
  const db = getDbInstance();

  const where: string[] = [];
  const params: unknown[] = [];

  if (!includeManaged) {
    where.push("visibility = ?");
    params.push("shared");
  }
  if (!includeInactive) {
    where.push("status = ?");
    params.push("active");
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `SELECT ${proxySelectColumns()}
       FROM proxy_registry
       ${whereSql}
       ORDER BY datetime(updated_at) DESC, name ASC`
    )
    .all(...params);

  const proxies = rows.map(mapProxyRow);
  return includeSecrets ? proxies : proxies.map(redactProxySecrets);
}

export async function getProxyById(id: string, options?: { includeSecrets?: boolean }) {
  const includeSecrets = options?.includeSecrets === true;
  const db = getDbInstance();
  const row = db.prepare(`SELECT ${proxySelectColumns()} FROM proxy_registry WHERE id = ?`).get(id);
  if (!row) return null;
  const proxy = mapProxyRow(row);
  return includeSecrets ? proxy : redactProxySecrets(proxy);
}

export async function createProxy(payload: ProxyPayload) {
  const db = getDbInstance();
  const id = randomUUID();
  const now = new Date().toISOString();
  const visibility = normalizeVisibility(payload.visibility);
  const ownerScope: ProxyScope | null =
    visibility === "managed" ? normalizeScope(payload.ownerScope || "global") : null;
  const ownerScopeId =
    visibility === "managed"
      ? normalizeOwnerScopeId(ownerScope || "global", payload.ownerScopeId || null)
      : null;

  db.prepare(
    `INSERT INTO proxy_registry
      (id, name, type, host, port, username, password, region, notes, status, visibility, owner_scope, owner_scope_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    payload.name,
    payload.type,
    payload.host,
    Number(payload.port),
    payload.username || "",
    payload.password || "",
    payload.region || null,
    payload.notes || null,
    normalizeStatus(payload.status),
    visibility,
    ownerScope,
    ownerScopeId,
    now,
    now
  );

  backupDbFile("pre-write");
  return getProxyById(id, { includeSecrets: false });
}

export async function updateProxy(id: string, payload: Partial<ProxyPayload>) {
  const db = getDbInstance();
  const existing = await getProxyById(id, { includeSecrets: true });
  if (!existing) return null;

  const incomingUsername =
    typeof payload.username === "string" ? payload.username.trim() : undefined;
  const incomingPassword =
    typeof payload.password === "string" ? payload.password.trim() : undefined;

  const visibility = payload.visibility
    ? normalizeVisibility(payload.visibility)
    : existing.visibility;
  const ownerScope: ProxyScope | null =
    visibility === "managed"
      ? normalizeScope((payload.ownerScope as string) || existing.ownerScope || "global")
      : null;
  const ownerScopeId =
    visibility === "managed"
      ? normalizeOwnerScopeId(
          ownerScope || "global",
          payload.ownerScopeId !== undefined ? payload.ownerScopeId || null : existing.ownerScopeId
        )
      : null;

  const merged = {
    ...existing,
    ...payload,
    username: incomingUsername === undefined ? existing.username : incomingUsername,
    password: incomingPassword === undefined ? existing.password : incomingPassword,
    visibility,
    ownerScope,
    ownerScopeId,
    status: normalizeStatus(payload.status || existing.status),
    updatedAt: new Date().toISOString(),
  };

  db.prepare(
    `UPDATE proxy_registry
       SET name = ?, type = ?, host = ?, port = ?, username = ?, password = ?, region = ?, notes = ?, status = ?, visibility = ?, owner_scope = ?, owner_scope_id = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    merged.name,
    merged.type,
    merged.host,
    Number(merged.port),
    merged.username || "",
    merged.password || "",
    merged.region || null,
    merged.notes || null,
    normalizeStatus(merged.status),
    merged.visibility,
    merged.ownerScope,
    merged.ownerScopeId,
    merged.updatedAt,
    id
  );

  backupDbFile("pre-write");
  return getProxyById(id, { includeSecrets: false });
}

export async function getProxyAssignments(filters?: { proxyId?: string; scope?: string }) {
  const db = getDbInstance();

  if (filters?.proxyId) {
    return db
      .prepare(
        "SELECT id, proxy_id, scope, scope_id, created_at, updated_at FROM proxy_assignments WHERE proxy_id = ? ORDER BY scope, scope_id"
      )
      .all(filters.proxyId)
      .map(mapAssignmentRow);
  }

  if (filters?.scope) {
    return db
      .prepare(
        "SELECT id, proxy_id, scope, scope_id, created_at, updated_at FROM proxy_assignments WHERE scope = ? ORDER BY scope_id"
      )
      .all(normalizeScope(filters.scope))
      .map(mapAssignmentRow);
  }

  return db
    .prepare(
      "SELECT id, proxy_id, scope, scope_id, created_at, updated_at FROM proxy_assignments ORDER BY scope, scope_id"
    )
    .all()
    .map(mapAssignmentRow);
}

export async function getProxyWhereUsed(proxyId: string) {
  const db = getDbInstance();
  const rows = db
    .prepare(
      "SELECT id, proxy_id, scope, scope_id, created_at, updated_at FROM proxy_assignments WHERE proxy_id = ? ORDER BY scope, scope_id"
    )
    .all(proxyId)
    .map(mapAssignmentRow);

  return {
    count: rows.length,
    assignments: rows,
  };
}

export async function getProxyAssignmentForScope(
  scope: string,
  scopeId: string | null,
  options?: { includeSecrets?: boolean }
) {
  const normalizedScope = normalizeScope(scope);
  const normalizedScopeId = normalizeScopeIdForAssignment(normalizedScope, scopeId);
  const db = getDbInstance();
  const row = db
    .prepare(
      `SELECT
         a.id AS assignment_id,
         a.proxy_id AS assignment_proxy_id,
         a.scope AS assignment_scope,
         a.scope_id AS assignment_scope_id,
         a.created_at AS assignment_created_at,
         a.updated_at AS assignment_updated_at,
         ${proxySelectColumns("p")}
       FROM proxy_assignments a
       JOIN proxy_registry p ON p.id = a.proxy_id
       WHERE a.scope = ? AND a.scope_id IS ?
       LIMIT 1`
    )
    .get(normalizedScope, normalizedScopeId);

  const assignment = mapAssignmentWithProxyRow(row);
  if (!assignment) return null;
  if (options?.includeSecrets === true) return assignment;
  return {
    ...assignment,
    proxy: redactProxySecrets(assignment.proxy),
  };
}

export async function getManagedProxyForScope(
  scope: string,
  scopeId: string | null,
  options?: { includeSecrets?: boolean }
) {
  const normalizedScope = normalizeScope(scope);
  const ownerScopeId = normalizeOwnerScopeId(normalizedScope, scopeId);
  const db = getDbInstance();
  const row = db
    .prepare(
      `SELECT ${proxySelectColumns()}
       FROM proxy_registry
       WHERE visibility = 'managed' AND owner_scope = ? AND owner_scope_id IS ?
       LIMIT 1`
    )
    .get(normalizedScope, ownerScopeId);

  if (!row) return null;
  const proxy = mapProxyRow(row);
  return options?.includeSecrets === true ? proxy : redactProxySecrets(proxy);
}

export async function deleteProxyIfUnused(id: string) {
  const proxy = await getProxyById(id, { includeSecrets: true });
  if (!proxy || proxy.visibility !== "managed") return false;
  const usage = await getProxyWhereUsed(id);
  if (usage.count > 0) return false;
  const db = getDbInstance();
  const result = db.prepare("DELETE FROM proxy_registry WHERE id = ?").run(id);
  if (result.changes > 0) {
    backupDbFile("pre-write");
    return true;
  }
  return false;
}

export async function assignProxyToScope(
  scope: string,
  scopeId: string | null,
  proxyId: string | null
): Promise<ProxyAssignmentRecord | null> {
  const normalizedScope = normalizeScope(scope);
  const normalizedScopeId = normalizeScopeIdForAssignment(normalizedScope, scopeId);
  const db = getDbInstance();

  if (!proxyId) {
    db.prepare("DELETE FROM proxy_assignments WHERE scope = ? AND scope_id IS ?").run(
      normalizedScope,
      normalizedScopeId
    );
    clearLegacyProxyConfigForScope(normalizedScope, scopeId);
    backupDbFile("pre-write");
    return null;
  }

  const proxy = await getProxyById(proxyId, { includeSecrets: true });
  if (!proxy) {
    const err = new Error(`Proxy not found: ${proxyId}`) as Error & { status?: number };
    err.status = 404;
    throw err;
  }

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO proxy_assignments (proxy_id, scope, scope_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(scope, scope_id)
     DO UPDATE SET proxy_id = excluded.proxy_id, updated_at = excluded.updated_at`
  ).run(proxyId, normalizedScope, normalizedScopeId, now, now);

  clearLegacyProxyConfigForScope(normalizedScope, scopeId);
  backupDbFile("pre-write");

  const row = db
    .prepare(
      "SELECT id, proxy_id, scope, scope_id, created_at, updated_at FROM proxy_assignments WHERE scope = ? AND scope_id IS ?"
    )
    .get(normalizedScope, normalizedScopeId);
  return row ? mapAssignmentRow(row) : null;
}

export async function setSharedProxyForScope(
  scope: string,
  scopeId: string | null,
  proxyId: string | null
) {
  const normalizedScope = normalizeScope(scope);
  const direct = await getProxyAssignmentForScope(normalizedScope, scopeId, {
    includeSecrets: true,
  });

  if (proxyId) {
    const nextProxy = await getProxyById(proxyId, { includeSecrets: true });
    if (!nextProxy) {
      const err = new Error(`Proxy not found: ${proxyId}`) as Error & { status?: number };
      err.status = 404;
      throw err;
    }
    if (nextProxy.visibility !== "shared") {
      throw createInvalidProxyError("Only shared proxies can be assigned through this endpoint");
    }
    if (!isActiveStatus(nextProxy.status)) {
      throw createInvalidProxyError("Inactive proxies cannot be assigned");
    }
  }

  const assignment = await assignProxyToScope(normalizedScope, scopeId, proxyId);
  if (
    direct &&
    direct.proxy.id !== proxyId &&
    isOwnedManagedProxy(direct.proxy, normalizedScope, scopeId)
  ) {
    await deleteProxyIfUnused(direct.proxy.id);
  }
  return assignment;
}

export async function upsertManagedProxyForScope(
  scope: string,
  scopeId: string | null,
  proxy: Omit<ProxyPayload, "name" | "visibility" | "ownerScope" | "ownerScopeId">
) {
  const normalizedScope = normalizeScope(scope);
  const direct = await getProxyAssignmentForScope(normalizedScope, scopeId, {
    includeSecrets: true,
  });
  const existingManaged = await getManagedProxyForScope(normalizedScope, scopeId, {
    includeSecrets: true,
  });
  const payload: ProxyPayload = {
    name: existingManaged?.name || buildManagedProxyName(normalizedScope, scopeId),
    type: proxy.type,
    host: proxy.host,
    port: Number(proxy.port),
    username: proxy.username || "",
    password: proxy.password || "",
    region: proxy.region || null,
    notes: proxy.notes || null,
    status: "active",
    visibility: "managed",
    ownerScope: normalizedScope,
    ownerScopeId: normalizeOwnerScopeId(normalizedScope, scopeId),
  };

  const managed =
    existingManaged?.id !== undefined
      ? await updateProxy(existingManaged.id, payload)
      : await createProxy(payload);

  if (!managed?.id) {
    throw createInvalidProxyError("Failed to persist managed proxy");
  }

  await assignProxyToScope(normalizedScope, scopeId, managed.id);

  if (
    direct &&
    direct.proxy.id !== managed.id &&
    isOwnedManagedProxy(direct.proxy, normalizedScope, scopeId)
  ) {
    await deleteProxyIfUnused(direct.proxy.id);
  }

  return getProxyById(managed.id, { includeSecrets: true });
}

export async function clearProxyForScope(scope: string, scopeId: string | null) {
  const normalizedScope = normalizeScope(scope);
  const direct = await getProxyAssignmentForScope(normalizedScope, scopeId, {
    includeSecrets: true,
  });
  await assignProxyToScope(normalizedScope, scopeId, null);
  if (direct && isOwnedManagedProxy(direct.proxy, normalizedScope, scopeId)) {
    await deleteProxyIfUnused(direct.proxy.id);
  }
  return null;
}

export async function resolveProxyForScopeFromRegistry(
  scope: string,
  scopeId: string | null,
  options?: ResolveProxyOptions
) {
  const assignment = await getProxyAssignmentForScope(scope, scopeId, {
    includeSecrets: options?.includeSecrets === true,
  });
  if (!assignment) return null;
  if (!options?.includeInactive && !isActiveStatus(assignment.status)) return null;
  return resolvedFromAssignment(assignment as ProxyAssignmentWithProxy);
}

export async function resolveProxyScopeStateFromRegistry(
  scope: string,
  scopeId: string | null,
  options?: { includeSecrets?: boolean; comboId?: string | null; comboName?: string | null }
): Promise<ScopeProxyState> {
  const normalizedScope = normalizeScope(scope);
  const includeSecrets = options?.includeSecrets === true;
  const direct = await getProxyAssignmentForScope(normalizedScope, scopeId, {
    includeSecrets: true,
  });

  const chain: Array<{ scope: ProxyScope; scopeId: string | null }> = [
    { scope: normalizedScope, scopeId },
  ];
  if (normalizedScope === "provider" || normalizedScope === "combo") {
    chain.push({ scope: "global", scopeId: null });
  } else if (normalizedScope === "account") {
    const db = getDbInstance();
    const connection = db
      .prepare("SELECT provider FROM provider_connections WHERE id = ?")
      .get(scopeId) as { provider?: string } | undefined;
    const provider =
      connection?.provider && connection.provider.trim().length > 0
        ? resolveProviderAliasOrId(connection.provider)
        : null;
    const comboScopeId = await getComboScopeIdForProvider(provider, {
      comboId: options?.comboId,
      comboName: options?.comboName,
    });
    if (comboScopeId) {
      chain.push({ scope: "combo", scopeId: comboScopeId });
    }
    if (provider) {
      chain.push({ scope: "provider", scopeId: provider });
    }
    chain.push({ scope: "global", scopeId: null });
  }

  let effective: ProxyAssignmentWithProxy | null = null;
  for (const entry of chain) {
    const candidate =
      entry.scope === normalizedScope && entry.scopeId === scopeId
        ? direct
        : await getProxyAssignmentForScope(entry.scope, entry.scopeId, { includeSecrets: true });
    if (candidate && isActiveStatus(candidate.status)) {
      effective = candidate as ProxyAssignmentWithProxy;
      break;
    }
  }

  const effectiveInfo = effective
    ? resolvedFromAssignment(effective)
    : {
        proxy: null,
        level: "direct" as const,
        levelId: null,
        source: "direct" as const,
        proxyId: null,
        visibility: null,
        status: null,
      };

  const inheritedFrom =
    effective &&
    (!direct || effective.scope !== direct.scope || effective.scopeId !== direct.scopeId)
      ? effectiveInfo
      : null;

  return {
    scope: normalizedScope,
    scopeId: normalizedScope === "global" ? null : scopeId,
    assignment: direct
      ? serializeAssignment(direct as ProxyAssignmentWithProxy, { includeSecrets })
      : null,
    effective:
      !effectiveInfo.proxy || includeSecrets
        ? effectiveInfo
        : {
            ...effectiveInfo,
            proxy: {
              ...effectiveInfo.proxy,
              username: effectiveInfo.proxy.username ? "***" : "",
              password: effectiveInfo.proxy.password ? "***" : "",
            },
          },
    inheritedFrom:
      !inheritedFrom || includeSecrets || !inheritedFrom.proxy
        ? inheritedFrom
        : {
            ...inheritedFrom,
            proxy: {
              ...inheritedFrom.proxy,
              username: inheritedFrom.proxy.username ? "***" : "",
              password: inheritedFrom.proxy.password ? "***" : "",
            },
          },
    proxyId: effectiveInfo.proxyId,
    visibility: effectiveInfo.visibility,
    status: effectiveInfo.status,
  };
}

export async function deleteProxyById(id: string, options?: { force?: boolean }) {
  const force = options?.force === true;
  const db = getDbInstance();
  const usage = await getProxyWhereUsed(id);

  if (!force && usage.count > 0) {
    const err = new Error(
      "Proxy is still assigned. Remove assignments first or use force=true"
    ) as Error & {
      status?: number;
      code?: string;
    };
    err.status = 409;
    err.code = "proxy_in_use";
    throw err;
  }

  if (force && usage.count > 0) {
    db.prepare("DELETE FROM proxy_assignments WHERE proxy_id = ?").run(id);
  }

  const result = db.prepare("DELETE FROM proxy_registry WHERE id = ?").run(id);
  backupDbFile("pre-write");
  return result.changes > 0;
}

export async function resolveProxyForConnectionFromRegistry(
  connectionId: string,
  options?: AccountProxyResolutionOptions
) {
  const state = await resolveProxyScopeStateFromRegistry("account", connectionId, {
    includeSecrets: true,
    comboId: options?.comboId,
    comboName: options?.comboName,
  });
  return state.effective.proxy ? state.effective : null;
}

export async function migrateLegacyProxyConfigToRegistry(options?: { force?: boolean }) {
  const force = options?.force === true;
  const db = getDbInstance();

  const existingCountRow = db.prepare("SELECT COUNT(*) AS cnt FROM proxy_registry").get() as
    | { cnt?: number }
    | undefined;
  const existingCount = Number(existingCountRow?.cnt || 0);
  if (!force && existingCount > 0) {
    return { migrated: 0, skipped: true, reason: "registry_not_empty" as const };
  }

  const rows = db
    .prepare("SELECT key, value FROM key_value WHERE namespace = 'proxyConfig'")
    .all() as Array<{ key?: string; value?: string }>;

  const raw: LegacyProxyConfig = {};
  for (const row of rows) {
    if (!row?.key || typeof row.value !== "string") continue;
    try {
      raw[row.key as keyof LegacyProxyConfig] = JSON.parse(row.value);
    } catch {
      // ignore malformed legacy entry
    }
  }

  let migrated = 0;

  if (raw.global) {
    const payload = coerceProxyPayload(raw.global, "Legacy Global Proxy", {
      scope: "global",
      scopeId: null,
    });
    if (payload) {
      const created = await createProxy(payload);
      if (created?.id) {
        await assignProxyToScope("global", null, created.id);
        migrated++;
      }
    }
  }

  for (const [providerId, proxyValue] of Object.entries(raw.providers || {})) {
    const payload = coerceProxyPayload(proxyValue, `Legacy Provider Proxy (${providerId})`, {
      scope: "provider",
      scopeId: providerId,
    });
    if (!payload) continue;
    const created = await createProxy(payload);
    if (created?.id) {
      await assignProxyToScope("provider", providerId, created.id);
      migrated++;
    }
  }

  for (const [comboId, proxyValue] of Object.entries(raw.combos || {})) {
    const payload = coerceProxyPayload(proxyValue, `Legacy Combo Proxy (${comboId})`, {
      scope: "combo",
      scopeId: comboId,
    });
    if (!payload) continue;
    const created = await createProxy(payload);
    if (created?.id) {
      await assignProxyToScope("combo", comboId, created.id);
      migrated++;
    }
  }

  for (const [connectionId, proxyValue] of Object.entries(raw.keys || {})) {
    const payload = coerceProxyPayload(proxyValue, `Legacy Account Proxy (${connectionId})`, {
      scope: "account",
      scopeId: connectionId,
    });
    if (!payload) continue;
    const created = await createProxy(payload);
    if (created?.id) {
      await assignProxyToScope("account", connectionId, created.id);
      migrated++;
    }
  }

  return { migrated, skipped: false as const };
}

export async function getProxyHealthStats(options?: { hours?: number }) {
  const db = getDbInstance();
  const hours = Math.max(1, Math.min(24 * 30, Number(options?.hours || 24)));
  const sinceIso = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const rows = db
    .prepare(
      `SELECT
         p.id as proxy_id,
         p.name as proxy_name,
         p.type as proxy_type,
         p.host as proxy_host,
         p.port as proxy_port,
         COUNT(l.id) as total_requests,
         SUM(CASE WHEN l.status = 'success' THEN 1 ELSE 0 END) as success_count,
         SUM(CASE WHEN l.status = 'error' THEN 1 ELSE 0 END) as error_count,
         SUM(CASE WHEN l.status = 'timeout' THEN 1 ELSE 0 END) as timeout_count,
         AVG(CASE WHEN l.latency_ms IS NOT NULL THEN l.latency_ms END) as avg_latency_ms,
         MAX(l.timestamp) as last_seen_at
       FROM proxy_registry p
       LEFT JOIN proxy_logs l
         ON l.proxy_host = p.host
        AND l.proxy_type = p.type
        AND l.proxy_port = p.port
        AND l.timestamp >= ?
       GROUP BY p.id, p.name, p.type, p.host, p.port
       ORDER BY p.name ASC`
    )
    .all(sinceIso) as Array<Record<string, unknown>>;

  return rows.map((row) => {
    const total = Number(row.total_requests || 0);
    const success = Number(row.success_count || 0);
    const error = Number(row.error_count || 0);
    const timeout = Number(row.timeout_count || 0);
    const successRate = total > 0 ? Math.round((success / total) * 10000) / 100 : null;

    return {
      proxyId: String(row.proxy_id || ""),
      name: String(row.proxy_name || ""),
      type: String(row.proxy_type || "http"),
      host: String(row.proxy_host || ""),
      port: Number(row.proxy_port || 0),
      totalRequests: total,
      successCount: success,
      errorCount: error,
      timeoutCount: timeout,
      successRate,
      avgLatencyMs:
        row.avg_latency_ms === null || row.avg_latency_ms === undefined
          ? null
          : Math.round(Number(row.avg_latency_ms)),
      lastSeenAt: row.last_seen_at ? String(row.last_seen_at) : null,
    };
  });
}

export async function bulkAssignProxyToScope(
  scope: string,
  scopeIds: string[],
  proxyId: string | null
): Promise<{ updated: number; failed: Array<{ scopeId: string; reason: string }> }> {
  const normalizedScope = normalizeScope(scope);
  const uniqueScopeIds =
    normalizedScope === "global"
      ? [""]
      : [...new Set((scopeIds || []).map((id) => String(id).trim()).filter(Boolean))];
  const failed: Array<{ scopeId: string; reason: string }> = [];
  let updated = 0;

  for (const entryScopeId of uniqueScopeIds) {
    const resolvedScopeId = normalizedScope === "global" ? null : entryScopeId;
    try {
      await setSharedProxyForScope(normalizedScope, resolvedScopeId, proxyId);
      updated++;
    } catch (error) {
      failed.push({
        scopeId: resolvedScopeId || "__global__",
        reason: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  return { updated, failed };
}
