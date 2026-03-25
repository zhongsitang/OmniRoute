// Re-export from open-sse with local logger
import * as log from "../utils/logger";
import { resolveProxyForConnection, updateProviderConnection } from "@/lib/localDb";
import { runWithProxyContext } from "@omniroute/open-sse/utils/proxyFetch.ts";
import {
  TOKEN_EXPIRY_BUFFER_MS as BUFFER_MS,
  refreshAccessToken as _refreshAccessToken,
  refreshClaudeOAuthToken as _refreshClaudeOAuthToken,
  refreshGoogleToken as _refreshGoogleToken,
  refreshQwenToken as _refreshQwenToken,
  refreshCodexToken as _refreshCodexToken,
  refreshIflowToken as _refreshIflowToken,
  refreshGitHubToken as _refreshGitHubToken,
  refreshCopilotToken as _refreshCopilotToken,
  getAccessToken as _getAccessToken,
  refreshTokenByProvider as _refreshTokenByProvider,
  formatProviderCredentials as _formatProviderCredentials,
  getAllAccessTokens as _getAllAccessTokens,
} from "@omniroute/open-sse/services/tokenRefresh.ts";

export const TOKEN_EXPIRY_BUFFER_MS = BUFFER_MS;

async function runWithRefreshProxy(credentials: any, fn: () => Promise<any>) {
  const connectionId =
    credentials && typeof credentials.connectionId === "string" ? credentials.connectionId : null;
  if (!connectionId) {
    return fn();
  }

  try {
    const proxyInfo = await resolveProxyForConnection(connectionId);
    return await runWithProxyContext(proxyInfo?.proxy || null, fn);
  } catch (error) {
    log.warn("PROXY", "Failed to resolve proxy for token refresh; falling back to direct", {
      connectionId,
      error: (error as Error).message,
    });
    return fn();
  }
}

export const refreshAccessToken = (provider: string, refreshToken: string, credentials: any) =>
  _refreshAccessToken(provider, refreshToken, credentials, log);

export const refreshClaudeOAuthToken = (refreshToken: string) =>
  _refreshClaudeOAuthToken(refreshToken, log);

export const refreshGoogleToken = (refreshToken: string, clientId: string, clientSecret: string) =>
  _refreshGoogleToken(refreshToken, clientId, clientSecret, log);

export const refreshQwenToken = (refreshToken: string) => _refreshQwenToken(refreshToken, log);

export const refreshCodexToken = (refreshToken: string) => _refreshCodexToken(refreshToken, log);

export const refreshIflowToken = (refreshToken: string) => _refreshIflowToken(refreshToken, log);

export const refreshGitHubToken = (refreshToken: string) => _refreshGitHubToken(refreshToken, log);

export const refreshCopilotToken = (githubAccessToken: string) =>
  _refreshCopilotToken(githubAccessToken, log);

export const getAccessToken = (provider: string, credentials: any) =>
  runWithRefreshProxy(credentials, () => _getAccessToken(provider, credentials, log));

export const refreshTokenByProvider = (provider: string, credentials: any) =>
  runWithRefreshProxy(credentials, () => _refreshTokenByProvider(provider, credentials, log));

export const formatProviderCredentials = (provider: string, credentials: any) =>
  _formatProviderCredentials(provider, credentials, log);

export const getAllAccessTokens = (userInfo: any) => _getAllAccessTokens(userInfo, log);

function normalizeProjectId(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}

function extractProjectIdFromCredentials(credentials: any): string | null {
  if (!credentials || typeof credentials !== "object") return null;

  const directProjectId = normalizeProjectId(credentials.projectId);
  if (directProjectId) return directProjectId;

  const providerSpecificData = asRecord(credentials.providerSpecificData);
  return normalizeProjectId(providerSpecificData.projectId);
}

export function buildGeminiCliProjectPersistenceUpdates(
  previousCredentials: any,
  refreshedCredentials: any
) {
  const projectId =
    extractProjectIdFromCredentials(refreshedCredentials) ||
    extractProjectIdFromCredentials(previousCredentials);
  if (!projectId) return {};

  const previousProviderData = asRecord(previousCredentials?.providerSpecificData);
  const refreshedProviderData = asRecord(refreshedCredentials?.providerSpecificData);
  const mergedProviderData = { ...previousProviderData, ...refreshedProviderData };

  return {
    projectId,
    providerSpecificData: {
      ...mergedProviderData,
      projectId,
    },
  };
}

async function discoverGeminiCliProjectId(accessToken: string): Promise<string | null> {
  if (!accessToken) return null;

  try {
    const response = await fetch("https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        metadata: {
          ideType: "IDE_UNSPECIFIED",
          platform: "PLATFORM_UNSPECIFIED",
          pluginType: "GEMINI",
        },
      }),
    });

    if (!response.ok) return null;

    const data = await response.json();
    const project = asRecord(data).cloudaicompanionProject;

    if (typeof project === "string") {
      return normalizeProjectId(project);
    }

    return normalizeProjectId(asRecord(project).id);
  } catch {
    return null;
  }
}

// Local-specific: Update credentials in localDb
export async function updateProviderCredentials(connectionId: string, newCredentials: any) {
  try {
    const updates: Record<string, any> = {};

    if (newCredentials.accessToken) {
      updates.accessToken = newCredentials.accessToken;
    }
    if (newCredentials.refreshToken) {
      updates.refreshToken = newCredentials.refreshToken;
    }
    if (newCredentials.expiresIn) {
      updates.expiresAt = new Date(Date.now() + newCredentials.expiresIn * 1000).toISOString();
      updates.expiresIn = newCredentials.expiresIn;
    }
    if (newCredentials.providerSpecificData) {
      updates.providerSpecificData = newCredentials.providerSpecificData;
    }
    if (newCredentials.projectId) {
      updates.projectId = newCredentials.projectId;
    }

    const result = await updateProviderConnection(connectionId, updates);
    log.info("TOKEN_REFRESH", "Credentials updated in localDb", {
      connectionId,
      success: !!result,
    });
    return !!result;
  } catch (error) {
    log.error("TOKEN_REFRESH", "Error updating credentials in localDb", {
      connectionId,
      error: (error as any).message,
    });
    return false;
  }
}

// Local-specific: Check and refresh token proactively
export async function checkAndRefreshToken(provider: string, credentials: any) {
  let updatedCredentials = { ...credentials };

  // Check regular token expiry
  if (updatedCredentials.expiresAt) {
    const expiresAt = new Date(updatedCredentials.expiresAt).getTime();
    const now = Date.now();

    if (expiresAt - now < TOKEN_EXPIRY_BUFFER_MS) {
      log.info("TOKEN_REFRESH", "Token expiring soon, refreshing proactively", {
        provider,
        expiresIn: Math.round((expiresAt - now) / 1000),
      });

      const newCredentials = await getAccessToken(provider, updatedCredentials);
      if (newCredentials && newCredentials.accessToken) {
        const persistencePayload =
          provider === "gemini-cli"
            ? {
                ...newCredentials,
                ...buildGeminiCliProjectPersistenceUpdates(updatedCredentials, newCredentials),
              }
            : newCredentials;

        await updateProviderCredentials(updatedCredentials.connectionId, persistencePayload);

        updatedCredentials = {
          ...updatedCredentials,
          accessToken: newCredentials.accessToken,
          refreshToken: newCredentials.refreshToken || updatedCredentials.refreshToken,
          expiresAt: newCredentials.expiresIn
            ? new Date(Date.now() + newCredentials.expiresIn * 1000).toISOString()
            : updatedCredentials.expiresAt,
        };

        if (provider === "gemini-cli") {
          const persistedProjectId = normalizeProjectId(persistencePayload.projectId);
          if (persistedProjectId) {
            updatedCredentials.projectId = persistedProjectId;
          }

          if (persistencePayload.providerSpecificData) {
            updatedCredentials.providerSpecificData = persistencePayload.providerSpecificData;
          }
        }
      }
    }
  }

  if (
    provider === "gemini-cli" &&
    updatedCredentials.accessToken &&
    !extractProjectIdFromCredentials(updatedCredentials)
  ) {
    const discoveredProjectId = await runWithRefreshProxy(updatedCredentials, () =>
      discoverGeminiCliProjectId(updatedCredentials.accessToken)
    );

    if (discoveredProjectId) {
      const persistencePayload = buildGeminiCliProjectPersistenceUpdates(updatedCredentials, {
        projectId: discoveredProjectId,
        providerSpecificData: { projectId: discoveredProjectId },
      });

      if (Object.keys(persistencePayload).length > 0) {
        await updateProviderCredentials(updatedCredentials.connectionId, persistencePayload);
        updatedCredentials = {
          ...updatedCredentials,
          ...persistencePayload,
          providerSpecificData:
            persistencePayload.providerSpecificData || updatedCredentials.providerSpecificData,
        };
      }
    }
  }

  // Check GitHub copilot token expiry
  if (provider === "github" && updatedCredentials.providerSpecificData?.copilotTokenExpiresAt) {
    const copilotExpiresAt = updatedCredentials.providerSpecificData.copilotTokenExpiresAt * 1000;
    const now = Date.now();

    if (copilotExpiresAt - now < TOKEN_EXPIRY_BUFFER_MS) {
      log.info("TOKEN_REFRESH", "Copilot token expiring soon, refreshing proactively", {
        provider,
        expiresIn: Math.round((copilotExpiresAt - now) / 1000),
      });

      const copilotToken = await refreshCopilotToken(updatedCredentials.accessToken);
      if (copilotToken) {
        await updateProviderCredentials(updatedCredentials.connectionId, {
          providerSpecificData: {
            ...updatedCredentials.providerSpecificData,
            copilotToken: copilotToken.token,
            copilotTokenExpiresAt: copilotToken.expiresAt,
          },
        });

        updatedCredentials.providerSpecificData = {
          ...updatedCredentials.providerSpecificData,
          copilotToken: copilotToken.token,
          copilotTokenExpiresAt: copilotToken.expiresAt,
        };
      }
    }
  }

  return updatedCredentials;
}

// Local-specific: Refresh GitHub and Copilot tokens together
export async function refreshGitHubAndCopilotTokens(credentials: any) {
  const newGitHubCredentials = await refreshGitHubToken(credentials.refreshToken);
  if (newGitHubCredentials?.accessToken) {
    const copilotToken = await refreshCopilotToken(newGitHubCredentials.accessToken);
    if (copilotToken) {
      return {
        ...newGitHubCredentials,
        providerSpecificData: {
          copilotToken: copilotToken.token,
          copilotTokenExpiresAt: copilotToken.expiresAt,
        },
      };
    }
  }
  return newGitHubCredentials;
}
