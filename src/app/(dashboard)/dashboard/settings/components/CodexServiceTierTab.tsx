"use client";

import { useEffect, useState } from "react";
import { Card } from "@/shared/components";

type ServiceTierMode = "passthrough" | "omit" | "priority";

interface ServiceTierPolicy {
  mode: ServiceTierMode;
}

const DEFAULT_POLICY: ServiceTierPolicy = {
  mode: "passthrough",
};

function normalizeMode(value: unknown): ServiceTierMode {
  if (value === "omit" || value === "priority") return value;
  return "passthrough";
}

export default function CodexServiceTierTab() {
  const [policy, setPolicy] = useState<ServiceTierPolicy>(DEFAULT_POLICY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<"" | "saved" | "error">("");

  useEffect(() => {
    fetch("/api/settings/codex-service-tier")
      .then((res) => res.json())
      .then((data) => {
        const nextPolicy = { mode: normalizeMode(data?.mode) };
        setPolicy(nextPolicy);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const saveMode = async (nextMode: ServiceTierMode) => {
    if (loading || saving || nextMode === policy.mode) return;

    const previousPolicy = policy;
    setPolicy({ mode: nextMode });
    setSaving(true);
    setStatus("");

    try {
      const res = await fetch("/api/settings/codex-service-tier", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: nextMode }),
      });

      if (res.ok) {
        const data = await res.json();
        setPolicy({ mode: normalizeMode(data?.mode) });
        setStatus("saved");
        setTimeout(() => setStatus(""), 2000);
      } else {
        setPolicy(previousPolicy);
        setStatus("error");
      }
    } catch {
      setPolicy(previousPolicy);
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
            tune
          </span>
        </div>
        <div className="flex-1">
          <h3 className="text-lg font-semibold">Service Tier Policy</h3>
          <p className="text-sm text-text-muted">
            Applies to Codex OAuth and OpenAI API-key requests. Choose passthrough, remove
            `service_tier`, or force `priority`.
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

      <div className="grid grid-cols-1 gap-2 mb-4">
        <button
          type="button"
          onClick={() => saveMode("passthrough")}
          disabled={loading || saving}
          aria-pressed={policy.mode === "passthrough"}
          className={`flex items-start gap-3 p-3 rounded-lg border text-left transition-all ${
            policy.mode === "passthrough"
              ? "border-sky-500/50 bg-sky-500/5 ring-1 ring-sky-500/20"
              : "border-border/50 hover:border-border hover:bg-surface/30"
          }`}
        >
          <span
            className={`material-symbols-outlined text-[20px] mt-0.5 ${
              policy.mode === "passthrough" ? "text-sky-500" : "text-text-muted"
            }`}
          >
            sync_alt
          </span>
          <div className="min-w-0">
            <p
              className={`text-sm font-medium ${
                policy.mode === "passthrough" ? "text-sky-400" : ""
              }`}
            >
              Passthrough
            </p>
            <p className="text-xs text-text-muted mt-0.5 leading-relaxed">
              Send the request raw. The proxy does not modify `service_tier`.
            </p>
          </div>
        </button>

        <button
          type="button"
          onClick={() => saveMode("omit")}
          disabled={loading || saving}
          aria-pressed={policy.mode === "omit"}
          className={`flex items-start gap-3 p-3 rounded-lg border text-left transition-all ${
            policy.mode === "omit"
              ? "border-sky-500/50 bg-sky-500/5 ring-1 ring-sky-500/20"
              : "border-border/50 hover:border-border hover:bg-surface/30"
          }`}
        >
          <span
            className={`material-symbols-outlined text-[20px] mt-0.5 ${
              policy.mode === "omit" ? "text-sky-500" : "text-text-muted"
            }`}
          >
            remove_circle
          </span>
          <div className="min-w-0">
            <p className={`text-sm font-medium ${policy.mode === "omit" ? "text-sky-400" : ""}`}>
              Remove service_tier
            </p>
            <p className="text-xs text-text-muted mt-0.5 leading-relaxed">
              Strip `service_tier` before sending the request upstream.
            </p>
          </div>
        </button>

        <button
          type="button"
          onClick={() => saveMode("priority")}
          disabled={loading || saving}
          aria-pressed={policy.mode === "priority"}
          className={`flex items-start gap-3 p-3 rounded-lg border text-left transition-all ${
            policy.mode === "priority"
              ? "border-sky-500/50 bg-sky-500/5 ring-1 ring-sky-500/20"
              : "border-border/50 hover:border-border hover:bg-surface/30"
          }`}
        >
          <span
            className={`material-symbols-outlined text-[20px] mt-0.5 ${
              policy.mode === "priority" ? "text-sky-500" : "text-text-muted"
            }`}
          >
            bolt
          </span>
          <div className="min-w-0">
            <p
              className={`text-sm font-medium ${policy.mode === "priority" ? "text-sky-400" : ""}`}
            >
              Force priority
            </p>
            <p className="text-xs text-text-muted mt-0.5 leading-relaxed">
              Override any incoming `service_tier` and always send `priority`.
            </p>
          </div>
        </button>
      </div>

      <div className="p-4 rounded-lg bg-surface/30 border border-border/30">
        <p className="text-xs text-text-muted leading-relaxed">
          Passthrough can still fail if the upstream rejects the client-provided tier. Remove
          `service_tier` is the safest non-priority option for Codex.
        </p>
      </div>
    </Card>
  );
}
