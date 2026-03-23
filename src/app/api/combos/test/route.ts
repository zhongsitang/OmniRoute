import { NextResponse } from "next/server";
import { getComboByName } from "@/lib/localDb";
import { testComboSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";

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

async function probeComboModel({ request, comboName, protocol, index, model, probeControllers }) {
  const startTime = Date.now();
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const controller = new AbortController();
  const handleAbort = () => controller.abort();

  request.signal.addEventListener("abort", handleAbort, { once: true });
  probeControllers.add(controller);

  try {
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
