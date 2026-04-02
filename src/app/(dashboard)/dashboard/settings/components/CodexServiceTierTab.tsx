"use client";

import { useEffect, useState } from "react";
import { Card, Input, Select } from "@/shared/components";

type CodexServiceTierMode = "passthrough" | "inject";

interface CodexServiceTierConfig {
  mode: CodexServiceTierMode;
  value: string;
}

const DEFAULT_SERVICE_TIER_VALUE = "priority";

const PRESET_TIER_OPTIONS = [
  { value: "priority", label: "priority" },
  { value: "flex", label: "flex" },
  { value: "default", label: "default" },
  { value: "auto", label: "auto" },
];

function normalizeMode(value: unknown): CodexServiceTierMode {
  return value === "inject" ? "inject" : "passthrough";
}

function normalizeTierValue(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_SERVICE_TIER_VALUE;
  const normalized = value.trim().toLowerCase();
  return normalized || DEFAULT_SERVICE_TIER_VALUE;
}

export default function CodexServiceTierTab() {
  const [currentConfig, setCurrentConfig] = useState<CodexServiceTierConfig>({
    mode: "passthrough",
    value: DEFAULT_SERVICE_TIER_VALUE,
  });
  const [mode, setMode] = useState<CodexServiceTierMode>("passthrough");
  const [tierValue, setTierValue] = useState(DEFAULT_SERVICE_TIER_VALUE);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<"" | "saved" | "error">("");

  useEffect(() => {
    fetch("/api/settings/codex-service-tier")
      .then((res) => res.json())
      .then((data) => {
        const nextMode = normalizeMode(data?.mode ?? (data?.enabled ? "inject" : "passthrough"));
        const nextValue = normalizeTierValue(data?.value);
        const nextConfig = { mode: nextMode, value: nextValue };
        setCurrentConfig(nextConfig);
        setMode(nextMode);
        setTierValue(nextValue);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const normalizedDraftValue = tierValue.trim().toLowerCase();
  const selectedPreset = PRESET_TIER_OPTIONS.some((item) => item.value === normalizedDraftValue)
    ? normalizedDraftValue
    : "custom";
  const isInjectValueMissing = mode === "inject" && !normalizedDraftValue;
  const isDirty = mode !== currentConfig.mode || normalizedDraftValue !== currentConfig.value;

  const save = async () => {
    if (isInjectValueMissing || !isDirty) return;

    setSaving(true);
    setStatus("");

    try {
      const payload: { mode: CodexServiceTierMode; value?: string } = { mode };
      if (normalizedDraftValue) {
        payload.value = normalizedDraftValue;
      }

      const res = await fetch("/api/settings/codex-service-tier", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        const data = await res.json();
        const nextMode = normalizeMode(data?.mode);
        const nextValue = normalizeTierValue(data?.value);
        const nextConfig = { mode: nextMode, value: nextValue };
        setCurrentConfig(nextConfig);
        setMode(nextMode);
        setTierValue(nextValue);
        setStatus("saved");
        setTimeout(() => setStatus(""), 2000);
      } else {
        setStatus("error");
      }
    } catch {
      setStatus("error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <div className="flex items-center gap-3 mb-5">
        <div className="p-2 rounded-lg bg-sky-500/10 text-sky-500">
          <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
            bolt
          </span>
        </div>
        <div className="flex-1">
          <h3 className="text-lg font-semibold">Codex Service Tier</h3>
          <p className="text-sm text-text-muted">
            Choose passthrough or inject a default `service_tier` when it is missing.
          </p>
        </div>
        {status === "saved" && (
          <span className="text-xs font-medium text-emerald-500 flex items-center gap-1">
            <span className="material-symbols-outlined text-[14px]">check_circle</span>
            Saved
          </span>
        )}
        {status === "error" && (
          <span className="text-xs font-medium text-rose-500 flex items-center gap-1">
            <span className="material-symbols-outlined text-[14px]">error</span>
            Failed to save
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-4">
        <button
          type="button"
          onClick={() => setMode("passthrough")}
          disabled={loading || saving}
          className={`flex items-start gap-3 p-3 rounded-lg border text-left transition-all ${
            mode === "passthrough"
              ? "border-sky-500/50 bg-sky-500/5 ring-1 ring-sky-500/20"
              : "border-border/50 hover:border-border hover:bg-surface/30"
          }`}
        >
          <span
            className={`material-symbols-outlined text-[20px] mt-0.5 ${
              mode === "passthrough" ? "text-sky-500" : "text-text-muted"
            }`}
          >
            sync_alt
          </span>
          <div className="min-w-0">
            <p className={`text-sm font-medium ${mode === "passthrough" ? "text-sky-400" : ""}`}>
              Passthrough
            </p>
            <p className="text-xs text-text-muted mt-0.5 leading-relaxed">
              Preserve client-provided `service_tier`. If missing, do not inject.
            </p>
          </div>
        </button>

        <button
          type="button"
          onClick={() => setMode("inject")}
          disabled={loading || saving}
          className={`flex items-start gap-3 p-3 rounded-lg border text-left transition-all ${
            mode === "inject"
              ? "border-sky-500/50 bg-sky-500/5 ring-1 ring-sky-500/20"
              : "border-border/50 hover:border-border hover:bg-surface/30"
          }`}
        >
          <span
            className={`material-symbols-outlined text-[20px] mt-0.5 ${
              mode === "inject" ? "text-sky-500" : "text-text-muted"
            }`}
          >
            add_circle
          </span>
          <div className="min-w-0">
            <p className={`text-sm font-medium ${mode === "inject" ? "text-sky-400" : ""}`}>
              Inject Default
            </p>
            <p className="text-xs text-text-muted mt-0.5 leading-relaxed">
              Inject this value only when the request does not include `service_tier`.
            </p>
          </div>
        </button>
      </div>

      <div className="p-4 rounded-lg bg-surface/30 border border-border/30 space-y-3">
        <p className="text-sm font-medium">service_tier value</p>
        <p className="text-xs text-text-muted">
          Choose a preset or type any custom value. The value is normalized to lowercase.
        </p>

        <Select
          label="Preset values"
          value={selectedPreset}
          disabled={loading || saving}
          onChange={(event) => {
            const nextValue = event.target.value;
            if (nextValue === "custom") return;
            setTierValue(nextValue);
          }}
          options={[...PRESET_TIER_OPTIONS, { value: "custom", label: "custom (manual input)" }]}
        />

        <Input
          label="Manual value"
          value={tierValue}
          onChange={(event) => setTierValue(event.target.value)}
          disabled={loading || saving}
          placeholder="priority"
          error={isInjectValueMissing ? "Value is required in Inject Default mode." : undefined}
        />
      </div>

      <div className="mt-4 flex items-center justify-between gap-3">
        <p className="text-xs text-text-muted">
          Current: {currentConfig.mode}
          {currentConfig.mode === "inject" ? ` (${currentConfig.value})` : ""}
        </p>
        <button
          type="button"
          onClick={save}
          disabled={loading || saving || isInjectValueMissing || !isDirty}
          className="px-3 py-2 rounded-md text-sm font-medium bg-sky-500 text-white hover:bg-sky-400 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {saving ? "Saving..." : "Save"}
        </button>
      </div>
    </Card>
  );
}
