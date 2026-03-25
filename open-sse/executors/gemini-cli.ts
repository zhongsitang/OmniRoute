import { BaseExecutor } from "./base.ts";
import { PROVIDERS, OAUTH_ENDPOINTS } from "../config/constants.ts";

function normalizeProjectId(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function resolveGeminiCliProjectId(credentials) {
  if (!credentials || typeof credentials !== "object") return null;

  const directProjectId = normalizeProjectId(credentials.projectId);
  if (directProjectId) return directProjectId;

  const providerSpecificData =
    credentials.providerSpecificData &&
    typeof credentials.providerSpecificData === "object" &&
    !Array.isArray(credentials.providerSpecificData)
      ? credentials.providerSpecificData
      : {};

  const providerProjectId = normalizeProjectId(providerSpecificData.projectId);
  if (providerProjectId) return providerProjectId;

  const cloudCodeProject = providerSpecificData.cloudaicompanionProject;
  if (typeof cloudCodeProject === "string") {
    return normalizeProjectId(cloudCodeProject);
  }

  if (cloudCodeProject && typeof cloudCodeProject === "object") {
    return normalizeProjectId(cloudCodeProject.id);
  }

  return null;
}

async function fetchGeminiCliProjectId(accessToken, log) {
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
    const project = data?.cloudaicompanionProject;
    if (typeof project === "string") {
      return normalizeProjectId(project);
    }
    return normalizeProjectId(project?.id);
  } catch (error) {
    log?.warn?.("TOKEN", `Gemini CLI project discovery after refresh failed: ${error.message}`);
    return null;
  }
}

export class GeminiCLIExecutor extends BaseExecutor {
  private _currentModel: string = "";

  constructor() {
    super("gemini-cli", PROVIDERS["gemini-cli"]);
  }

  buildUrl(model, stream, urlIndex = 0) {
    const action = stream ? "streamGenerateContent?alt=sse" : "generateContent";
    return `${this.config.baseUrl}:${action}`;
  }

  buildHeaders(credentials, stream = true) {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${credentials.accessToken}`,
      // Fingerprint headers matching native GeminiCLI client (prevents upstream rejection)
      "User-Agent": `GeminiCLI/0.31.0/${this._currentModel || "unknown"} (linux; x64)`,
      "X-Goog-Api-Client": "google-genai-sdk/1.41.0 gl-node/v22.19.0",
      ...(stream && { Accept: "text/event-stream" }),
    };
  }

  transformRequest(model, body, stream, credentials) {
    // Capture model so buildHeaders (called after transformRequest) can include it in User-Agent
    this._currentModel = model || "";

    const allowBodyProjectOverride = process.env.OMNIROUTE_ALLOW_BODY_PROJECT_OVERRIDE === "1";

    // Default: prefer OAuth-stored projectId. Incoming body.project can be stale
    // when clients cache older Cloud Code project values.
    // Opt-in escape hatch: set OMNIROUTE_ALLOW_BODY_PROJECT_OVERRIDE=1.
    if (allowBodyProjectOverride && body?.project) {
      return body;
    }

    const resolvedProjectId = resolveGeminiCliProjectId(credentials);
    if (resolvedProjectId) {
      body.project = resolvedProjectId;
    }
    return body;
  }

  async refreshCredentials(credentials, log) {
    if (!credentials.refreshToken) return null;

    try {
      const response = await fetch(OAUTH_ENDPOINTS.google.token, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: credentials.refreshToken,
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
        }),
      });

      if (!response.ok) return null;

      const tokens = await response.json();
      const projectId =
        (await fetchGeminiCliProjectId(tokens.access_token, log)) ||
        resolveGeminiCliProjectId(credentials);
      log?.info?.("TOKEN", "Gemini CLI refreshed");

      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || credentials.refreshToken,
        expiresIn: tokens.expires_in,
        projectId,
        providerSpecificData: projectId
          ? {
              ...(credentials?.providerSpecificData || {}),
              projectId,
            }
          : credentials?.providerSpecificData,
      };
    } catch (error) {
      log?.error?.("TOKEN", `Gemini CLI refresh error: ${error.message}`);
      return null;
    }
  }
}

export default GeminiCLIExecutor;
