"use client";

import { useEffect, useState } from "react";
import { Button, Card, Input } from "@/shared/components";
import { useTranslations } from "next-intl";

const FALLBACK_TIMEOUT_MS = 120000;
const MAX_STREAM_IDLE_TIMEOUT_MS = 600000;

function clampStreamIdleTimeoutMs(value: number, fallback: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(MAX_STREAM_IDLE_TIMEOUT_MS, Math.trunc(value)));
}

export default function StreamTimeoutsTab() {
  const [streamIdleTimeoutMs, setStreamIdleTimeoutMs] = useState(FALLBACK_TIMEOUT_MS);
  const [defaultTimeoutMs, setDefaultTimeoutMs] = useState(FALLBACK_TIMEOUT_MS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const t = useTranslations("settings");

  const title =
    typeof t.has === "function" && t.has("streamingTimeoutTitle")
      ? t("streamingTimeoutTitle")
      : "Streaming Timeouts";
  const description =
    typeof t.has === "function" && t.has("streamingTimeoutDesc")
      ? t("streamingTimeoutDesc")
      : "Configure how long OmniRoute waits before aborting a stalled streaming response.";
  const label =
    typeof t.has === "function" && t.has("streamIdleTimeoutLabel")
      ? t("streamIdleTimeoutLabel")
      : "Stream Idle Timeout (ms)";
  const saveLabel =
    typeof t.has === "function" && t.has("saveStreamingTimeouts")
      ? t("saveStreamingTimeouts")
      : "Save Streaming Timeout";

  useEffect(() => {
    fetch("/api/settings/streaming")
      .then((res) => res.json())
      .then((data) => {
        const fallback = clampStreamIdleTimeoutMs(
          Number(data.defaultStreamIdleTimeoutMs),
          FALLBACK_TIMEOUT_MS
        );
        setDefaultTimeoutMs(fallback);
        setStreamIdleTimeoutMs(
          clampStreamIdleTimeoutMs(Number(data.streamIdleTimeoutMs), fallback)
        );
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const save = async () => {
    const normalized = clampStreamIdleTimeoutMs(Number(streamIdleTimeoutMs), defaultTimeoutMs);
    setSaving(true);
    setStatus("");
    try {
      const res = await fetch("/api/settings/streaming", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ streamIdleTimeoutMs: normalized }),
      });
      if (!res.ok) throw new Error("save_failed");
      const data = await res.json();
      const fallback = clampStreamIdleTimeoutMs(
        Number(data.defaultStreamIdleTimeoutMs),
        FALLBACK_TIMEOUT_MS
      );
      setDefaultTimeoutMs(fallback);
      setStreamIdleTimeoutMs(clampStreamIdleTimeoutMs(Number(data.streamIdleTimeoutMs), fallback));
      setStatus("saved");
      setTimeout(() => setStatus(""), 2000);
    } catch {
      setStatus("error");
    } finally {
      setSaving(false);
    }
  };

  const hint =
    streamIdleTimeoutMs === 0
      ? typeof t.has === "function" && t.has("streamIdleTimeoutDisabledHint")
        ? t("streamIdleTimeoutDisabledHint")
        : "0 disables the idle watchdog entirely."
      : typeof t.has === "function" && t.has("streamIdleTimeoutHint")
        ? t("streamIdleTimeoutHint", { defaultMs: defaultTimeoutMs })
        : `Abort stalled streaming requests after this much silence. Default: ${defaultTimeoutMs}ms.`;

  return (
    <Card>
      <div className="flex items-center gap-3 mb-4">
        <div className="p-2 rounded-lg bg-cyan-500/10 text-cyan-500">
          <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
            timer
          </span>
        </div>
        <div className="flex-1">
          <h3 className="text-lg font-semibold">{title}</h3>
          <p className="text-sm text-text-muted">{description}</p>
        </div>
        {status === "saved" && (
          <span className="text-xs font-medium text-emerald-500 flex items-center gap-1">
            <span className="material-symbols-outlined text-[14px]">check_circle</span>
            {t("saved")}
          </span>
        )}
      </div>

      <div className="flex flex-col gap-4">
        <Input
          label={label}
          type="number"
          min={0}
          max={MAX_STREAM_IDLE_TIMEOUT_MS}
          step={5000}
          value={streamIdleTimeoutMs}
          onChange={(e) =>
            setStreamIdleTimeoutMs(
              clampStreamIdleTimeoutMs(Number.parseInt(e.target.value || "0", 10), 0)
            )
          }
          hint={hint}
          disabled={loading || saving}
        />

        <div className="flex items-center gap-3">
          <Button variant="primary" size="sm" onClick={save} loading={saving} disabled={loading}>
            {saveLabel}
          </Button>
          {status === "error" && (
            <span className="text-xs text-red-500">
              {typeof t.has === "function" && t.has("saveFailed")
                ? t("saveFailed")
                : "Failed to save"}
            </span>
          )}
        </div>
      </div>
    </Card>
  );
}
