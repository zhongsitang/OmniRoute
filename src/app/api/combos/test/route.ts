import { NextResponse } from "next/server";
import { getComboByName } from "@/lib/localDb";
import { testComboSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";

/**
 * POST /api/combos/test - Quick test a combo
 * Sends a minimal request through each model in the combo to verify availability
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

    const models = (combo.models || []).map((m) => (typeof m === "string" ? m : m.model));

    if (models.length === 0) {
      return NextResponse.json({ error: "Combo has no models" }, { status: 400 });
    }

    const results = [];
    let resolvedBy = null;

    // Test each model sequentially
    for (const modelStr of models) {
      const startTime = Date.now();
      let timeout: ReturnType<typeof setTimeout> | null = null;
      try {
        const probe = buildComboProbeRequest(modelStr, protocol);
        const internalUrl = `${getBaseUrl(request)}${probe.path}`;
        const controller = new AbortController();
        timeout = setTimeout(() => controller.abort(), 20000); // 20s timeout (was 15s, slow providers need more)

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
          results.push({ model: modelStr, status: "ok", latencyMs });
          if (!resolvedBy) resolvedBy = modelStr;
          // For test, we can stop after first success (like a real combo would)
          // But let's test all models to show full health
        } else {
          let errorMsg = "";
          try {
            const errBody = await res.json();
            errorMsg = errBody?.error?.message || errBody?.error || res.statusText;
          } catch {
            errorMsg = res.statusText;
          }
          results.push({
            model: modelStr,
            status: "error",
            statusCode: res.status,
            error: errorMsg,
            latencyMs,
          });
        }
      } catch (error) {
        const latencyMs = Date.now() - startTime;
        results.push({
          model: modelStr,
          status: "error",
          error: error.name === "AbortError" ? "Timeout (20s)" : error.message,
          latencyMs,
        });
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }

    return NextResponse.json({
      comboName,
      protocol,
      strategy: combo.strategy || "priority",
      resolvedBy,
      results,
      testedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.log("Error testing combo:", error);
    return NextResponse.json({ error: "Failed to test combo" }, { status: 500 });
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
        input: "Hi",
        max_output_tokens: 5,
        stream: false,
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
