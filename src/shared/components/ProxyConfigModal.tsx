"use client";

import { useState, useEffect } from "react";
import PropTypes from "prop-types";
import Modal from "./Modal";
import Button from "./Button";

const ALL_PROXY_TYPES = [
  { value: "http", label: "HTTP" },
  { value: "https", label: "HTTPS" },
  { value: "socks5", label: "SOCKS5" },
];
const SOCKS5_UI_ENABLED = process.env.NEXT_PUBLIC_ENABLE_SOCKS5_PROXY === "true";
const PROXY_TYPES = SOCKS5_UI_ENABLED
  ? ALL_PROXY_TYPES
  : ALL_PROXY_TYPES.filter((type) => type.value !== "socks5");

const LEVEL_LABELS = {
  global: "Global",
  provider: "Provider",
  combo: "Combo",
  key: "Key",
  direct: "Direct (none)",
};

type ProxyRecord = {
  id?: string;
  name?: string;
  type?: string;
  host?: string;
  port?: string | number;
  username?: string;
  password?: string;
  status?: string;
  visibility?: string;
};

type ScopeResolvePayload = {
  assignment?: {
    proxyId?: string;
    proxy?: ProxyRecord | null;
    visibility?: string | null;
    status?: string | null;
  } | null;
  effective?: {
    level?: string;
    proxy?: ProxyRecord | null;
  } | null;
  inheritedFrom?: {
    level?: string;
    proxy?: ProxyRecord | null;
  } | null;
};

function normalizeScope(level: string) {
  return level === "key" ? "key" : level;
}

function normalizeType(type: string | undefined) {
  const normalizedType = String(type || "http").toLowerCase();
  const hasTypeOption = PROXY_TYPES.some((entry) => entry.value === normalizedType);
  return hasTypeOption ? normalizedType : PROXY_TYPES[0]?.value || "http";
}

/**
 * ProxyConfigModal — Reusable proxy configuration modal for all 4 levels
 * @param {Object} props
 * @param {boolean} props.isOpen
 * @param {Function} props.onClose
 * @param {"global"|"provider"|"combo"|"key"} props.level
 * @param {string} [props.levelId] — providerId, comboId, or connectionId
 * @param {string} [props.levelLabel] — display name for the level
 * @param {Function} [props.onSaved] — callback after save
 */
export default function ProxyConfigModal({
  isOpen,
  onClose,
  level,
  levelId,
  levelLabel,
  onSaved,
}: {
  isOpen: any;
  onClose: any;
  level: any;
  levelId?: any;
  levelLabel?: any;
  onSaved?: any;
}) {
  const [mode, setMode] = useState("saved");
  const [savedProxies, setSavedProxies] = useState<ProxyRecord[]>([]);
  const [selectedProxyId, setSelectedProxyId] = useState("");
  const [proxyType, setProxyType] = useState(PROXY_TYPES[0]?.value || "http");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showAuth, setShowAuth] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [inheritedFrom, setInheritedFrom] = useState<ScopeResolvePayload["inheritedFrom"]>(null);
  const [hasOwnProxy, setHasOwnProxy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const getDefaultPort = (type) => {
    if (type === "socks5") return "1080";
    if (type === "https") return "443";
    return "8080";
  };

  const resetFields = () => {
    setProxyType(PROXY_TYPES[0]?.value || "http");
    setHost("");
    setPort("");
    setUsername("");
    setPassword("");
    setShowAuth(false);
    setFormError(null);
  };

  const applyProxyToForm = (proxy: ProxyRecord | null | undefined) => {
    if (!proxy?.host) {
      resetFields();
      return;
    }

    const normalizedType = normalizeType(proxy.type);
    setProxyType(normalizedType);
    setHost(proxy.host || "");
    setPort(proxy.port === undefined || proxy.port === null ? "" : String(proxy.port));
    setUsername(proxy.username || "");
    setPassword(proxy.password || "");
    setShowAuth(!!(proxy.username || proxy.password));

    if (normalizedType === "socks5" && !SOCKS5_UI_ENABLED) {
      setFormError(
        "SOCKS5 is configured but hidden because NEXT_PUBLIC_ENABLE_SOCKS5_PROXY=false."
      );
    }
  };

  const buildCustomProxyPayload = () => ({
    type: proxyType,
    host: host.trim(),
    port: String(port || "").trim() || getDefaultPort(proxyType),
    username: username.trim(),
    password: password.trim(),
  });

  // Load existing proxy config when modal opens
  useEffect(() => {
    if (!isOpen) return;
    setTestResult(null);
    setFormError(null);
    setLoading(true);

    const loadProxy = async () => {
      try {
        const resolveParams = new URLSearchParams({ scope: normalizeScope(level) });
        if (level !== "global" && levelId) {
          resolveParams.set("scopeId", levelId);
        }

        const [registryRes, resolveRes] = await Promise.all([
          fetch("/api/settings/proxies", { cache: "no-store" }),
          fetch(`/api/settings/proxies/resolve?${resolveParams}`, { cache: "no-store" }),
        ]);

        const registryPayload = registryRes.ok ? await registryRes.json() : {};
        const initialSavedProxies = Array.isArray(registryPayload?.items)
          ? registryPayload.items
          : [];

        let nextSavedProxies = [...initialSavedProxies];
        setInheritedFrom(null);
        setHasOwnProxy(false);

        if (resolveRes.ok) {
          const resolved = (await resolveRes.json()) as ScopeResolvePayload;
          const directAssignment = resolved.assignment;
          const inherited = resolved.inheritedFrom;

          setInheritedFrom(inherited || null);
          setHasOwnProxy(!!directAssignment?.proxyId);

          if (
            directAssignment?.visibility === "shared" &&
            directAssignment.proxyId &&
            directAssignment.proxy
          ) {
            setMode("saved");
            setSelectedProxyId(directAssignment.proxyId);
            resetFields();

            if (
              !nextSavedProxies.some((item: ProxyRecord) => item.id === directAssignment.proxyId)
            ) {
              nextSavedProxies = [
                {
                  id: directAssignment.proxyId,
                  name: "Assigned Proxy",
                  type: directAssignment.proxy.type || "http",
                  host: directAssignment.proxy.host || "",
                  port: directAssignment.proxy.port || "",
                  status: directAssignment.status || "inactive",
                },
                ...nextSavedProxies,
              ];
            }
          } else if (directAssignment?.visibility === "managed" && directAssignment.proxy) {
            setMode("custom");
            setSelectedProxyId("");
            applyProxyToForm(directAssignment.proxy);
          } else {
            setMode(nextSavedProxies.length > 0 ? "saved" : "custom");
            setSelectedProxyId("");
            resetFields();
          }
        } else {
          setMode(nextSavedProxies.length > 0 ? "saved" : "custom");
          setSelectedProxyId("");
          resetFields();
        }

        setSavedProxies(nextSavedProxies);
      } catch (error) {
        console.error("Error loading proxy config:", error);
      } finally {
        setLoading(false);
      }
    };

    loadProxy();
  }, [isOpen, level, levelId]);

  const handleSave = async () => {
    if (mode === "saved" && !selectedProxyId) {
      setFormError("Select a saved proxy before saving.");
      return;
    }
    if (mode === "custom" && !host.trim()) return;
    setFormError(null);
    setSaving(true);
    try {
      const scope = level === "key" ? "key" : level;
      let res;
      if (mode === "saved") {
        res = await fetch("/api/settings/proxies/assignments", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            scope,
            scopeId: level === "global" ? null : levelId,
            proxyId: selectedProxyId,
          }),
        });
      } else {
        res = await fetch("/api/settings/proxy", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ level, id: levelId, proxy: buildCustomProxyPayload() }),
        });
      }
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFormError(payload?.error?.message || "Failed to save proxy configuration");
        return;
      }
      onClose?.();
      await Promise.resolve(onSaved?.());
    } catch (error) {
      console.error("Error saving proxy:", error);
      setFormError(error.message || "Failed to save proxy configuration");
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    setFormError(null);
    setSaving(true);
    try {
      const params = new URLSearchParams({ level });
      if (levelId) params.set("id", levelId);
      const res = await fetch(`/api/settings/proxy?${params}`, { method: "DELETE" });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFormError(payload?.error?.message || "Failed to clear proxy configuration");
        return;
      }
      resetFields();
      setTestResult(null);
      onClose?.();
      await Promise.resolve(onSaved?.());
    } catch (error) {
      console.error("Error clearing proxy:", error);
      setFormError(error.message || "Failed to clear proxy configuration");
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    if (mode === "saved") {
      setFormError("Use custom mode to run manual connection test.");
      return;
    }
    if (!host.trim()) return;
    setFormError(null);
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/settings/proxy/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proxy: buildCustomProxyPayload() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const message = data?.error?.message || "Connection failed";
        setTestResult({ success: false, error: message });
        setFormError(message);
        return;
      }
      setTestResult(data);
    } catch (error) {
      setTestResult({ success: false, error: error.message });
      setFormError(error.message || "Connection failed");
    } finally {
      setTesting(false);
    }
  };

  const title =
    level === "global"
      ? "Global Proxy Configuration"
      : `${LEVEL_LABELS[level]} Proxy — ${levelLabel || levelId || ""}`;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} maxWidth="lg">
      {loading ? (
        <div className="py-8 text-center text-text-muted animate-pulse">
          Loading proxy configuration...
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          {/* Inheritance indicator */}
          {level !== "global" && !hasOwnProxy && inheritedFrom && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-500/10 border border-blue-500/20 text-sm">
              <span className="material-symbols-outlined text-blue-400 text-base">
                subdirectory_arrow_right
              </span>
              <span className="text-blue-300">
                Inheriting from{" "}
                <strong>
                  {LEVEL_LABELS[inheritedFrom.level || "direct"] || inheritedFrom.level}
                </strong>
                : {inheritedFrom.proxy?.type}://{inheritedFrom.proxy?.host}:
                {inheritedFrom.proxy?.port}
              </span>
            </div>
          )}

          {/* Proxy Type Selector */}
          <div>
            <label className="text-xs text-text-muted mb-1.5 block uppercase tracking-wider font-medium">
              Source
            </label>
            <div className="flex gap-2">
              <button
                onClick={() => setMode("saved")}
                className={`px-3 py-2 rounded text-sm border transition-colors ${
                  mode === "saved"
                    ? "bg-primary text-white border-primary"
                    : "bg-bg-subtle text-text-muted border-border"
                }`}
              >
                Saved Proxy
              </button>
              <button
                onClick={() => setMode("custom")}
                className={`px-3 py-2 rounded text-sm border transition-colors ${
                  mode === "custom"
                    ? "bg-primary text-white border-primary"
                    : "bg-bg-subtle text-text-muted border-border"
                }`}
              >
                Custom
              </button>
            </div>
          </div>

          {mode === "saved" && (
            <div>
              <label className="text-xs text-text-muted mb-1.5 block uppercase tracking-wider font-medium">
                Saved Proxy
              </label>
              <select
                value={selectedProxyId}
                onChange={(e) => setSelectedProxyId(e.target.value)}
                className="w-full px-3 py-2.5 rounded-lg bg-bg-subtle border border-border text-sm text-text-primary"
              >
                <option value="">Select saved proxy...</option>
                {savedProxies.map((item: any) => (
                  <option key={item.id} value={item.id}>
                    {item.name} ({item.type}://{item.host}:{item.port}
                    {item.status && item.status !== "active" ? ` · ${item.status}` : ""})
                  </option>
                ))}
              </select>
            </div>
          )}

          {mode === "custom" && (
            <>
              <div>
                <label className="text-xs text-text-muted mb-1.5 block uppercase tracking-wider font-medium">
                  Proxy Type
                </label>
                <div className="flex gap-1 bg-bg-subtle rounded-lg p-1 border border-border">
                  {PROXY_TYPES.map((t) => (
                    <button
                      key={t.value}
                      onClick={() => setProxyType(t.value)}
                      className={`flex-1 px-4 py-2 rounded-md text-sm font-medium transition-all ${
                        proxyType === t.value
                          ? "bg-primary text-white shadow-sm"
                          : "text-text-muted hover:text-text-primary hover:bg-black/5 dark:hover:bg-white/5"
                      }`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Host + Port */}
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <label className="text-xs text-text-muted mb-1.5 block uppercase tracking-wider font-medium">
                    Host
                  </label>
                  <input
                    type="text"
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    placeholder="1.2.3.4 or proxy.example.com"
                    className="w-full px-3 py-2.5 rounded-lg bg-bg-subtle border border-border text-sm text-text-primary placeholder:text-text-muted/50 focus:outline-none focus:border-primary transition-colors"
                  />
                </div>
                <div>
                  <label className="text-xs text-text-muted mb-1.5 block uppercase tracking-wider font-medium">
                    Port
                  </label>
                  <input
                    type="text"
                    value={port}
                    onChange={(e) => setPort(e.target.value)}
                    placeholder={getDefaultPort(proxyType)}
                    className="w-full px-3 py-2.5 rounded-lg bg-bg-subtle border border-border text-sm text-text-primary placeholder:text-text-muted/50 focus:outline-none focus:border-primary transition-colors"
                  />
                </div>
              </div>

              {/* Auth Toggle */}
              <div>
                <button
                  onClick={() => setShowAuth(!showAuth)}
                  className="flex items-center gap-2 text-sm text-text-muted hover:text-text-primary transition-colors"
                >
                  <span className="material-symbols-outlined text-base">
                    {showAuth ? "expand_less" : "expand_more"}
                  </span>
                  Authentication (optional)
                </button>
                {showAuth && (
                  <div className="grid grid-cols-2 gap-3 mt-3">
                    <div>
                      <label className="text-xs text-text-muted mb-1.5 block uppercase tracking-wider font-medium">
                        Username
                      </label>
                      <input
                        type="text"
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        placeholder="Username"
                        className="w-full px-3 py-2.5 rounded-lg bg-bg-subtle border border-border text-sm text-text-primary placeholder:text-text-muted/50 focus:outline-none focus:border-primary transition-colors"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-text-muted mb-1.5 block uppercase tracking-wider font-medium">
                        Password
                      </label>
                      <input
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="Password"
                        className="w-full px-3 py-2.5 rounded-lg bg-bg-subtle border border-border text-sm text-text-primary placeholder:text-text-muted/50 focus:outline-none focus:border-primary transition-colors"
                      />
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          {/* Test Result */}
          {formError && (
            <div className="px-4 py-3 rounded-lg border border-red-500/30 bg-red-500/10 text-sm text-red-400">
              {formError}
            </div>
          )}

          {testResult && (
            <div
              className={`flex items-center gap-3 px-4 py-3 rounded-lg border ${
                testResult.success
                  ? "bg-emerald-500/10 border-emerald-500/30"
                  : "bg-red-500/10 border-red-500/30"
              }`}
            >
              <span
                className={`material-symbols-outlined text-xl ${
                  testResult.success ? "text-emerald-400" : "text-red-400"
                }`}
              >
                {testResult.success ? "check_circle" : "error"}
              </span>
              <div className="flex-1">
                {testResult.success ? (
                  <div>
                    <span className="text-sm font-medium text-emerald-400">Connected</span>
                    <span className="text-text-muted text-xs ml-2">
                      IP: <span className="font-mono text-emerald-300">{testResult.publicIp}</span>
                      {testResult.latencyMs && ` · ${testResult.latencyMs}ms`}
                    </span>
                  </div>
                ) : (
                  <div className="text-sm text-red-400">
                    {testResult.error || "Connection failed"}
                    {testResult.latencyMs && (
                      <span className="text-text-muted text-xs ml-2">
                        ({testResult.latencyMs}ms)
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center justify-between pt-2 border-t border-border">
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="secondary"
                icon="speed"
                onClick={handleTest}
                loading={testing}
                disabled={mode !== "custom" || !host.trim()}
              >
                Test Connection
              </Button>
              {hasOwnProxy && (
                <Button
                  size="sm"
                  variant="ghost"
                  icon="delete"
                  onClick={handleClear}
                  disabled={saving}
                  className="!text-red-400 hover:!bg-red-500/10"
                >
                  Clear
                </Button>
              )}
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" onClick={onClose}>
                Cancel
              </Button>
              <Button
                size="sm"
                icon="save"
                onClick={handleSave}
                loading={saving}
                disabled={mode === "saved" ? !selectedProxyId : !host.trim()}
              >
                Save
              </Button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

ProxyConfigModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  level: PropTypes.oneOf(["global", "provider", "combo", "key"]).isRequired,
  levelId: PropTypes.string,
  levelLabel: PropTypes.string,
  onSaved: PropTypes.func,
};
