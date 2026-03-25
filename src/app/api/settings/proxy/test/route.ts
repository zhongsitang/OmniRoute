import { request as undiciRequest } from "undici";
import {
  createProxyDispatcher,
  proxyConfigToUrl,
  proxyUrlForLogs,
} from "@omniroute/open-sse/utils/proxyDispatcher.ts";
import { testProxySchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { createErrorResponse, createErrorResponseFromUnknown } from "@/lib/api/errorResponse";
import { isSocks5ProxyEnabled, normalizeAndValidateProxyType } from "@/lib/proxyValidation";

function getErrorMessage(error: unknown, fallbackMessage: string): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallbackMessage;
}

/**
 * POST /api/settings/proxy/test — test proxy connectivity
 * Body: { proxy: { type, host, port, username?, password? } }
 * Returns: { success, publicIp?, latencyMs?, error? }
 */
export async function POST(request: Request) {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return createErrorResponse({
      status: 400,
      message: "Invalid JSON body",
      type: "invalid_request",
    });
  }

  try {
    const validation = validateBody(testProxySchema, rawBody);
    if (isValidationFailure(validation)) {
      return createErrorResponse({
        status: 400,
        message: validation.error.message,
        details: validation.error.details,
        type: "invalid_request",
      });
    }
    const { proxy } = validation.data;

    const proxyType = normalizeAndValidateProxyType(proxy.type, "proxy.type");

    let proxyUrl: string;
    try {
      const normalizedProxyUrl = proxyConfigToUrl(
        {
          type: proxyType,
          host: proxy.host,
          port: proxy.port,
          username: proxy.username || "",
          password: proxy.password || "",
        },
        { allowSocks5: isSocks5ProxyEnabled() }
      );
      if (!normalizedProxyUrl) {
        return createErrorResponse({
          status: 400,
          message: "Invalid proxy configuration",
          type: "invalid_request",
        });
      }
      proxyUrl = normalizedProxyUrl;
    } catch (proxyError) {
      return createErrorResponse({
        status: 400,
        message: getErrorMessage(proxyError, "Invalid proxy configuration"),
        type: "invalid_request",
      });
    }

    const publicProxyUrl = proxyUrlForLogs(proxyUrl);

    const startTime = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const dispatcher = createProxyDispatcher(proxyUrl);

    try {
      const result = await undiciRequest("https://api.ipify.org?format=json", {
        method: "GET",
        dispatcher,
        signal: controller.signal,
        headersTimeout: 10000,
        bodyTimeout: 10000,
      });

      const responseText = await result.body.text();
      let parsed: { ip?: string };
      try {
        const parsedJson = JSON.parse(responseText);
        if (parsedJson && typeof parsedJson === "object") {
          parsed = parsedJson as { ip?: string };
        } else {
          parsed = { ip: String(parsedJson) };
        }
      } catch {
        parsed = { ip: responseText.trim() };
      }

      return Response.json({
        success: true,
        publicIp: parsed.ip || null,
        latencyMs: Date.now() - startTime,
        proxyUrl: publicProxyUrl,
      });
    } catch (fetchError) {
      return Response.json({
        success: false,
        error:
          fetchError instanceof Error && fetchError.name === "AbortError"
            ? "Connection timeout (10s)"
            : getErrorMessage(fetchError, "Connection failed"),
        latencyMs: Date.now() - startTime,
        proxyUrl: publicProxyUrl,
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    return createErrorResponseFromUnknown(error, "Unexpected server error");
  }
}
