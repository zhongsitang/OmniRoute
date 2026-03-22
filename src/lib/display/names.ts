/**
 * Centralized display name helpers for provider and account/connection labels.
 *
 * Prevents raw internal IDs (connection UUIDs, dynamic provider IDs) from
 * leaking into user-facing dashboards (Health, Analytics, Sessions, Rate-limits,
 * Quota, Compatible Provider pages, etc.).
 *
 * Priority order:
 *   — Account: name → displayName → email → short readble label
 *   — Provider: node.name → node.prefix → alias → readable ID
 *
 * @module lib/display/names
 */

import {
  getProviderByAlias,
  isAnthropicCompatibleProvider,
  isOpenAICompatibleProvider,
} from "@/shared/constants/providers";

export interface ConnectionLike {
  id?: string | null;
  name?: string | null;
  displayName?: string | null;
  email?: string | null;
}

export interface ProviderNodeLike {
  id?: string | null;
  name?: string | null;
  prefix?: string | null;
}

interface ProviderDisplayNameOptions {
  anthropicCompatibleLabel?: string;
  openAICompatibleLabel?: string;
  unknownLabel?: string;
}

function toNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function findProviderNode(
  providerId: string | null | undefined,
  providerNodes: ProviderNodeLike[] = []
): ProviderNodeLike | null {
  if (!providerId || !Array.isArray(providerNodes) || providerNodes.length === 0) {
    return null;
  }

  return (
    providerNodes.find(
      (node) =>
        toNonEmptyString(node?.id) === providerId || toNonEmptyString(node?.prefix) === providerId
    ) || null
  );
}

/**
 * Friendly display name for an account/connection.
 *
 * Priority: name → displayName → email → "Account #<6-char ID>"
 */
export function getAccountDisplayName(conn: ConnectionLike): string {
  if (!conn) return "Unknown Account";
  const name =
    (typeof conn.name === "string" && conn.name.trim()) ||
    (typeof conn.displayName === "string" && conn.displayName.trim()) ||
    (typeof conn.email === "string" && conn.email.trim());
  if (name) return name;
  if (typeof conn.id === "string" && conn.id) {
    return `Account #${conn.id.slice(0, 6)}`;
  }
  return "Unknown Account";
}

/**
 * Friendly display name for a provider node/ID.
 *
 * Priority: built-in provider name → node.name → node.prefix → generic compatible label → providerId
 */
export function getProviderDisplayName(
  providerId: string | null | undefined,
  providerNodeOrNodes?: ProviderNodeLike | ProviderNodeLike[] | null,
  options: ProviderDisplayNameOptions = {}
): string {
  const providerNode = Array.isArray(providerNodeOrNodes)
    ? findProviderNode(providerId, providerNodeOrNodes)
    : providerNodeOrNodes;

  const providerInfo = providerId ? getProviderByAlias(providerId) : null;
  if (providerInfo?.name) return providerInfo.name;

  const nodeName = toNonEmptyString(providerNode?.name);
  if (nodeName) return nodeName;

  const nodePrefix = toNonEmptyString(providerNode?.prefix);
  if (nodePrefix) return nodePrefix;

  if (!providerId) return options.unknownLabel || "Unknown Provider";
  if (isOpenAICompatibleProvider(providerId)) {
    return options.openAICompatibleLabel || "OpenAI Compatible";
  }
  if (isAnthropicCompatibleProvider(providerId)) {
    return options.anthropicCompatibleLabel || "Anthropic Compatible";
  }

  return providerId;
}
