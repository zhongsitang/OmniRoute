import { NextResponse } from "next/server";
import { z } from "zod";
import { getSettings, updateSettings } from "@/lib/localDb";
import { STREAM_IDLE_TIMEOUT_MS as DEFAULT_STREAM_IDLE_TIMEOUT_MS } from "@omniroute/open-sse/config/constants.ts";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";

const updateStreamingSettingsSchema = z.object({
  streamIdleTimeoutMs: z.coerce.number().int().min(0).max(600000),
});

function resolveStreamIdleTimeoutMs(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  }

  return Math.trunc(parsed);
}

/**
 * GET /api/settings/streaming
 * Returns the effective stream idle timeout used by SSE watchdogs.
 */
export async function GET() {
  try {
    const settings: any = await getSettings();
    return NextResponse.json({
      streamIdleTimeoutMs: resolveStreamIdleTimeoutMs(settings?.streamIdleTimeoutMs),
      defaultStreamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    });
  } catch (error) {
    console.error("[API ERROR] /api/settings/streaming GET:", error);
    return NextResponse.json({ error: "Failed to load streaming settings" }, { status: 500 });
  }
}

/**
 * PUT /api/settings/streaming
 * Update the SSE stream idle timeout used for stalled upstream detection.
 * Body: { streamIdleTimeoutMs: number }
 */
export async function PUT(request) {
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
    const validation = validateBody(updateStreamingSettingsSchema, rawBody);
    if (isValidationFailure(validation)) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    const { streamIdleTimeoutMs } = validation.data;
    await updateSettings({ streamIdleTimeoutMs });

    return NextResponse.json({
      success: true,
      streamIdleTimeoutMs,
      defaultStreamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    });
  } catch (error) {
    console.error("[API ERROR] /api/settings/streaming PUT:", error);
    return NextResponse.json({ error: "Failed to update streaming settings" }, { status: 500 });
  }
}
