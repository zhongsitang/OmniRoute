const BASE_SUPPORTED_PROXY_TYPES = new Set(["http", "https"]);

type ProxyValidationError = Error & { status?: number; type?: string };

function createInvalidProxyError(message: string): ProxyValidationError {
  const error = new Error(message) as ProxyValidationError;
  error.status = 400;
  error.type = "invalid_request";
  return error;
}

export function isSocks5ProxyEnabled() {
  return process.env.ENABLE_SOCKS5_PROXY === "true";
}

export function getSupportedProxyTypes() {
  if (isSocks5ProxyEnabled()) {
    return new Set([...BASE_SUPPORTED_PROXY_TYPES, "socks5"]);
  }
  return BASE_SUPPORTED_PROXY_TYPES;
}

export function supportedProxyTypesMessage() {
  return isSocks5ProxyEnabled() ? "http, https, or socks5" : "http or https";
}

export function normalizeAndValidateProxyType(
  type: unknown,
  pathLabel = "type"
): "http" | "https" | "socks5" {
  const normalizedType = String(type || "http").toLowerCase();

  if (normalizedType === "socks5" && !isSocks5ProxyEnabled()) {
    throw createInvalidProxyError(
      "SOCKS5 proxy is disabled (set ENABLE_SOCKS5_PROXY=true to enable)"
    );
  }
  if (normalizedType.startsWith("socks") && normalizedType !== "socks5") {
    throw createInvalidProxyError(`${pathLabel} must be ${supportedProxyTypesMessage()}`);
  }
  if (!getSupportedProxyTypes().has(normalizedType)) {
    throw createInvalidProxyError(`${pathLabel} must be ${supportedProxyTypesMessage()}`);
  }

  return normalizedType as "http" | "https" | "socks5";
}
