export const GOOGLE_OAUTH_PROVIDERS = new Set(["antigravity", "gemini-cli"]);

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);

type OAuthRedirectContext = {
  provider?: string | null;
  hostname: string;
  origin: string;
  protocol: string;
  port: string;
  publicBaseUrl?: string | null;
};

function normalizeOrigin(origin: string): string {
  return origin.replace(/\/$/, "");
}

function resolvePublicOrigin(origin: string, publicBaseUrl?: string | null): string {
  const normalizedPublicBaseUrl = publicBaseUrl?.trim().replace(/\/$/, "");
  if (normalizedPublicBaseUrl && normalizedPublicBaseUrl !== "http://localhost:20128") {
    return normalizedPublicBaseUrl;
  }

  return normalizeOrigin(origin);
}

export function isTrueLocalhostHost(hostname?: string | null): boolean {
  return LOOPBACK_HOSTNAMES.has((hostname || "").toLowerCase());
}

export function shouldUseLocalCodexCallbackServer(
  provider?: string | null,
  hostname?: string | null
): boolean {
  return provider === "codex" && isTrueLocalhostHost(hostname);
}

export function resolveOAuthRedirectUri({
  provider,
  hostname,
  origin,
  protocol,
  port,
  publicBaseUrl,
}: OAuthRedirectContext): string {
  const normalizedProvider = provider || "";
  const isTrueLocalhost = isTrueLocalhostHost(hostname);

  if (normalizedProvider === "codex" || normalizedProvider === "openai") {
    // OpenAI's built-in Codex/OpenAI OAuth clients are registered for the
    // localhost callback only. Remote deployments must keep the localhost
    // redirect URI and fall back to manual URL paste after the browser
    // lands on the failed localhost callback page.
    return "http://localhost:1455/auth/callback";
  }

  if (GOOGLE_OAUTH_PROVIDERS.has(normalizedProvider)) {
    const localhostPort = port || "20128";
    return `http://localhost:${localhostPort}/callback`;
  }

  if (!isTrueLocalhost) {
    return `${resolvePublicOrigin(origin, publicBaseUrl)}/callback`;
  }

  const localhostPort = port || (protocol === "https:" ? "443" : "80");
  return `http://localhost:${localhostPort}/callback`;
}

export function shouldUseManualOAuthFallback(
  redirectUri?: string | null,
  currentOrigin?: string | null
): boolean {
  if (!redirectUri || !currentOrigin) {
    return true;
  }

  try {
    return new URL(redirectUri).origin !== normalizeOrigin(currentOrigin);
  } catch {
    return true;
  }
}

export function isLoopbackRedirectUri(redirectUri?: string | null): boolean {
  if (!redirectUri) {
    return false;
  }

  try {
    return isTrueLocalhostHost(new URL(redirectUri).hostname);
  } catch {
    return false;
  }
}
