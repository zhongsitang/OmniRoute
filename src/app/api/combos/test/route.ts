import { NextResponse } from "next/server";
import { getComboByName, getProviderConnections } from "@/lib/localDb";
import { testComboSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { getModelInfo } from "@/sse/services/model";

const PROBE_TIMEOUT_MS = 20000;

/**
 * POST /api/combos/test - Quick test a combo
 * Tests each model in the combo and can stream per-model updates for the dashboard.
 */
export async function POST(request) {
  let rawBody;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      {
        error: {
          message: "Invalid request",
          details: [{ field: "body", message: "Invalid JSON body" }],
        },
      },
      { status: 400 }
    );
  }

  try {
    const validation = validateBody(testComboSchema, rawBody);
    if (isValidationFailure(validation)) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    const { comboName, protocol = "responses" } = validation.data;
    const combo = await getComboByName(comboName);

    if (!combo) {
      return NextResponse.json({ error: "Combo not found" }, { status: 404 });
    }

    const models = getComboModelDescriptors(combo);
    if (models.length === 0) {
      return NextResponse.json({ error: "Combo has no models" }, { status: 400 });
    }

    const meta = {
      comboName,
      protocol,
      strategy: combo.strategy || "priority",
    };

    if (wantsStreamingResponse(request)) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          const send = (payload) => {
            if (request.signal.aborted) return;
            controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
          };

          try {
            send({
              type: "start",
              data: buildComboTestPayload({
                ...meta,
                results: models.map(({ index, model }) => ({
                  index,
                  model,
                  status: "pending",
                })),
              }),
            });

            const { results, resolvedBy } = await runComboTest({
              request,
              comboName,
              protocol,
              models,
              onResult: (result) => {
                send({ type: "result", data: result });
              },
            });

            send({
              type: "complete",
              data: buildComboTestPayload({
                ...meta,
                resolvedBy,
                results,
              }),
            });
          } catch (error) {
            if (!request.signal.aborted) {
              send({
                type: "error",
                error: error?.message || "Failed to test combo",
              });
            }
          } finally {
            if (!request.signal.aborted) {
              try {
                controller.close();
              } catch {}
            }
          }
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      });
    }

    const { results, resolvedBy } = await runComboTest({
      request,
      comboName,
      protocol,
      models,
    });

    return NextResponse.json(
      buildComboTestPayload({
        ...meta,
        resolvedBy,
        results,
      })
    );
  } catch (error) {
    console.log("Error testing combo:", error);
    return NextResponse.json({ error: "Failed to test combo" }, { status: 500 });
  }
}

function wantsStreamingResponse(request) {
  const accept = request.headers.get("accept") || "";
  return (
    accept.includes("application/x-ndjson") || request.headers.get("x-omniroute-stream") === "1"
  );
}

function getComboModelDescriptors(combo) {
  return (combo.models || [])
    .map((entry, index) => ({
      index,
      model: typeof entry === "string" ? entry : entry?.model,
    }))
    .filter((entry) => !!entry.model);
}

function buildComboTestPayload({
  comboName,
  protocol,
  strategy,
  resolvedBy = null,
  results = [],
  testedAt = new Date().toISOString(),
}) {
  return {
    comboName,
    protocol,
    strategy,
    resolvedBy,
    results,
    testedAt,
  };
}

async function runComboTest({ request, comboName, protocol, models, onResult }) {
  const results = new Array(models.length);
  const probeControllers = new Set();
  const geminiCliInventoryCache = new Map();
  const abortAll = () => {
    for (const controller of probeControllers) {
      controller.abort();
    }
  };

  request.signal.addEventListener("abort", abortAll);

  try {
    await Promise.all(
      models.map(async ({ index, model }) => {
        const result = await probeComboModel({
          request,
          comboName,
          protocol,
          index,
          model,
          probeControllers,
          geminiCliInventoryCache,
        });

        if (request.signal.aborted) return;

        results[index] = result;

        if (onResult) {
          await onResult(result);
        }
      })
    );
  } finally {
    request.signal.removeEventListener("abort", abortAll);
  }

  const orderedResults = results.filter(Boolean);
  const resolvedBy = orderedResults.find((result) => result.status === "ok")?.model || null;

  return { results: orderedResults, resolvedBy };
}

function buildGeminiCliInventoryHeaders(request) {
  const headers = {
    "X-OmniRoute-No-Cache": "true",
    "Cache-Control": "no-cache",
  };

  const cookie = request.headers.get("cookie");
  if (cookie) {
    headers.cookie = cookie;
  }

  const authorization = request.headers.get("authorization");
  if (authorization) {
    headers.authorization = authorization;
  }

  return headers;
}

async function loadGeminiCliInventoryForConnection(request, connectionId, inventoryCache) {
  if (inventoryCache.has(connectionId)) {
    return await inventoryCache.get(connectionId);
  }

  const inventoryPromise = (async () => {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const controller = new AbortController();
    const handleAbort = () => controller.abort();

    request.signal.addEventListener("abort", handleAbort, { once: true });
    if (request.signal.aborted) controller.abort();

    try {
      const inventoryUrl = `${getBaseUrl(request)}/api/providers/${connectionId}/models`;
      timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
      const response = await fetch(inventoryUrl, {
        method: "GET",
        headers: buildGeminiCliInventoryHeaders(request),
        signal: controller.signal,
      });

      let payload = null;
      try {
        payload = await response.json();
      } catch {}

      return response.ok
        ? {
            ok: true,
            models: new Set(
              Array.isArray(payload?.models)
                ? payload.models
                    .map((entry) => (typeof entry?.id === "string" ? entry.id : null))
                    .filter(Boolean)
                : []
            ),
          }
        : {
            ok: false,
            statusCode: response.status,
            error: payload?.error || "Failed to fetch Gemini CLI models",
          };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return {
          ok: false,
          statusCode: request.signal.aborted ? 503 : 504,
          error: request.signal.aborted
            ? "Request cancelled"
            : `Gemini CLI model discovery timed out (${PROBE_TIMEOUT_MS / 1000}s).`,
        };
      }

      return {
        ok: false,
        statusCode: 503,
        error: error instanceof Error ? error.message : "Failed to fetch Gemini CLI models",
      };
    } finally {
      if (timeout) clearTimeout(timeout);
      request.signal.removeEventListener("abort", handleAbort);
    }
  })();

  inventoryCache.set(connectionId, inventoryPromise);
  return await inventoryPromise;
}

async function precheckGeminiCliModelAvailability(request, model, inventoryCache) {
  const modelInfo = await getModelInfo(model);
  if (modelInfo.provider !== "gemini-cli") return null;

  const activeConnections = await getProviderConnections({
    provider: "gemini-cli",
    isActive: true,
  });
  if (!Array.isArray(activeConnections) || activeConnections.length === 0) {
    return {
      statusCode: 503,
      error: "No active Gemini CLI connection available for combo probe.",
    };
  }

  let sawSuccessfulInventory = false;
  let firstInventoryFailure = null;

  for (const connection of activeConnections) {
    const connectionId = typeof connection?.id === "string" ? connection.id : null;
    if (!connectionId) continue;

    const inventory = await loadGeminiCliInventoryForConnection(
      request,
      connectionId,
      inventoryCache
    );
    if (!inventory.ok) {
      if (!firstInventoryFailure) {
        firstInventoryFailure = {
          statusCode: inventory.statusCode,
          error:
            typeof inventory.error === "string"
              ? inventory.error
              : "Failed to discover Gemini CLI models.",
        };
      }
      continue;
    }

    sawSuccessfulInventory = true;
    if (inventory.models.has(modelInfo.model)) {
      return null;
    }
  }

  if (firstInventoryFailure) {
    return firstInventoryFailure;
  }

  if (sawSuccessfulInventory) {
    return {
      statusCode: 404,
      error: `Model ${modelInfo.model} is not available for the current Gemini CLI account.`,
    };
  }

  return (
    firstInventoryFailure || {
      statusCode: 503,
      error: "Failed to discover Gemini CLI models.",
    }
  );
}

async function probeComboModel({
  request,
  comboName,
  protocol,
  index,
  model,
  probeControllers,
  geminiCliInventoryCache,
}) {
  const startTime = Date.now();
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const controller = new AbortController();
  const handleAbort = () => controller.abort();

  request.signal.addEventListener("abort", handleAbort, { once: true });
  probeControllers.add(controller);

  try {
    const geminiCliPrecheck = await precheckGeminiCliModelAvailability(
      request,
      model,
      geminiCliInventoryCache
    );
    if (geminiCliPrecheck) {
      return {
        index,
        model,
        status: "error",
        statusCode: geminiCliPrecheck.statusCode,
        error: geminiCliPrecheck.error,
        latencyMs: Date.now() - startTime,
      };
    }

    const probe = buildComboProbeRequest(model, protocol);
    const internalUrl = `${getBaseUrl(request)}${probe.path}`;
    timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

    const res = await fetch(internalUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Fix #350: bypass REQUIRE_API_KEY for internal admin combo tests
        "X-Internal-Test": "combo-health-check",
        "X-OmniRoute-Combo-Name": comboName,
        "X-OmniRoute-No-Cache": "true",
        "X-OmniRoute-No-Dedup": "true",
        "X-OmniRoute-Live-Probe": "true",
        "Cache-Control": "no-cache",
      },
      body: JSON.stringify(probe.body),
      signal: controller.signal,
    });

    const latencyMs = Date.now() - startTime;

    if (res.ok) {
      return {
        index,
        model,
        status: "ok",
        latencyMs,
      };
    }

    let errorMsg = "";
    try {
      const errBody = await res.json();
      errorMsg = errBody?.error?.message || errBody?.error || res.statusText;
    } catch {
      errorMsg = res.statusText;
    }

    return {
      index,
      model,
      status: "error",
      statusCode: res.status,
      error: errorMsg,
      latencyMs,
    };
  } catch (error) {
    const latencyMs = Date.now() - startTime;
    return {
      index,
      model,
      status: "error",
      error:
        error.name === "AbortError"
          ? request.signal.aborted
            ? "Request cancelled"
            : `Timeout (${PROBE_TIMEOUT_MS / 1000}s)`
          : error.message,
      latencyMs,
    };
  } finally {
    if (timeout) clearTimeout(timeout);
    request.signal.removeEventListener("abort", handleAbort);
    probeControllers.delete(controller);
  }
}

/**
 * Get the base URL for internal requests (VPS-safe: respects reverse proxy headers)
 */
function getBaseUrl(request) {
  const fwdHost = request.headers.get("x-forwarded-host");
  const fwdProto = request.headers.get("x-forwarded-proto") || "https";
  if (fwdHost) return `${fwdProto}://${fwdHost}`;
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

function buildComboProbeRequest(modelStr, protocol) {
  if (protocol === "responses") {
    return {
      path: "/v1/responses",
      body: {
        model: modelStr,
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Hi" }],
          },
        ],
        instructions: "Reply briefly.",
        store: false,
        stream: true,
      },
    };
  }

  if (protocol === "claude") {
    return {
      path: "/v1/messages",
      body: {
        model: modelStr,
        messages: [{ role: "user", content: "Hi" }],
        max_tokens: 5,
        stream: false,
      },
    };
  }

  return {
    path: "/v1/chat/completions",
    body: {
      model: modelStr,
      messages: [{ role: "user", content: "Hi" }],
      // Prefer max_completion_tokens here so detectFormat() keeps this
      // probe in the OpenAI family instead of falling into Claude heuristics.
      max_completion_tokens: 5,
      stream: false,
    },
  };
}
