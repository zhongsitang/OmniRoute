"use client";

import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Card from "@/shared/components/Card";
import { CardSkeleton } from "@/shared/components/Loading";
import { supportsProviderUsageMonitoring } from "@/shared/constants/providers";
import ProviderUsageRow from "./ProviderUsageRow";
import {
  buildUsageSections,
  getI18nOrFallback,
  normalizePlanTier,
  parseProviderUsageData,
  type LimitsGroupBy,
  type ProviderConnectionSummary,
  type ProviderUsageEntry,
} from "./utils";

const LS_GROUP_BY = "omniroute:limits:groupBy";
const LS_AUTO_REFRESH = "omniroute:limits:autoRefresh";
const LS_EXPANDED_GROUPS = "omniroute:limits:expandedGroups";

const REFRESH_INTERVAL_MS = 120000;
const MIN_FETCH_INTERVAL_MS = 30000;
const TABLE_GRID_COLUMNS = "260px minmax(0,1fr) 88px 44px";

const TIER_FILTERS = [
  { key: "all", labelKey: "tierAll" },
  { key: "enterprise", labelKey: "tierEnterprise" },
  { key: "team", labelKey: "tierTeam" },
  { key: "business", labelKey: "tierBusiness" },
  { key: "ultra", labelKey: "tierUltra" },
  { key: "pro", labelKey: "tierPro" },
  { key: "plus", labelKey: "tierPlus" },
  { key: "free", labelKey: "tierFree" },
  { key: "unknown", labelKey: "tierUnknown" },
] as const;

type TierFilterKey = (typeof TIER_FILTERS)[number]["key"];
type TierMeta = ReturnType<typeof normalizePlanTier>;
type FetchQuotaOptions = { force?: boolean };
type UsageConnection = ProviderConnectionSummary;

export default function ProviderLimits() {
  const t = useTranslations("usage");
  const locale = useLocale();
  const [connections, setConnections] = useState<ProviderConnectionSummary[]>([]);
  const [quotaData, setQuotaData] = useState<Record<string, ProviderUsageEntry>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const [autoRefresh, setAutoRefresh] = useState(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem(LS_AUTO_REFRESH) === "true";
  });
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [countdown, setCountdown] = useState(120);
  const [initialLoading, setInitialLoading] = useState(true);
  const [tierFilter, setTierFilter] = useState<TierFilterKey>("all");
  const [groupBy, setGroupBy] = useState<LimitsGroupBy>(() => {
    if (typeof window === "undefined") return "none";
    const saved = localStorage.getItem(LS_GROUP_BY);
    if (saved === "environment" || saved === "type" || saved === "none") return saved;
    return "type";
  });
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set();
    try {
      const saved = localStorage.getItem(LS_EXPANDED_GROUPS);
      return saved ? new Set(JSON.parse(saved)) : new Set();
    } catch {
      return new Set();
    }
  });

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastFetchTimeRef = useRef<Record<string, number>>({});

  const isUsageConnection = useCallback(
    (conn: ProviderConnectionSummary) =>
      supportsProviderUsageMonitoring(conn.provider) &&
      (conn.authType === "oauth" || conn.authType === "apikey"),
    []
  );

  const fetchConnections = useCallback(async (): Promise<ProviderConnectionSummary[]> => {
    try {
      const response = await fetch("/api/providers/client");
      if (!response.ok) throw new Error("Failed");
      const data = await response.json();
      const list = Array.isArray(data.connections) ? data.connections : [];
      setConnections(list);
      return list;
    } catch {
      setConnections([]);
      return [];
    }
  }, []);

  const fetchQuota = useCallback(
    async (
      connectionId: string,
      provider: string,
      options: FetchQuotaOptions = {}
    ): Promise<void> => {
      const force = options.force === true;
      const now = Date.now();
      const lastFetch = lastFetchTimeRef.current[connectionId] || 0;

      if (!force && now - lastFetch < MIN_FETCH_INTERVAL_MS) {
        return;
      }
      lastFetchTimeRef.current[connectionId] = now;

      setLoading((prev) => ({ ...prev, [connectionId]: true }));
      setErrors((prev) => ({ ...prev, [connectionId]: null }));

      try {
        const response = await fetch(`/api/usage/${connectionId}`);
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          const errorMsg = errorData.error || response.statusText;

          if (response.status === 404) return;
          if (response.status === 401) {
            setQuotaData((prev) => ({
              ...prev,
              [connectionId]: { mode: "quota", quotas: [], balance: null, message: errorMsg },
            }));
            return;
          }

          throw new Error(`HTTP ${response.status}: ${errorMsg}`);
        }

        const data = await response.json();
        const parsedUsage = parseProviderUsageData(provider, data);
        setQuotaData((prev) => ({
          ...prev,
          [connectionId]: {
            ...parsedUsage,
            plan: data.plan || null,
            raw: data,
          },
        }));
      } catch (error) {
        setErrors((prev) => ({
          ...prev,
          [connectionId]: error instanceof Error ? error.message : "Failed to fetch quota",
        }));
      } finally {
        setLoading((prev) => ({ ...prev, [connectionId]: false }));
      }
    },
    []
  );

  const refreshProvider = useCallback(
    async (connectionId: string, provider: string) => {
      await fetchQuota(connectionId, provider, { force: true });
    },
    [fetchQuota]
  );

  const markConnectionsLoading = useCallback((targetConnections: UsageConnection[]) => {
    if (targetConnections.length === 0) return;

    setLoading((prev) => {
      const next = { ...prev };
      for (const connection of targetConnections) {
        next[connection.id] = true;
      }
      return next;
    });

    setErrors((prev) => {
      const next = { ...prev };
      for (const connection of targetConnections) {
        next[connection.id] = null;
      }
      return next;
    });
  }, []);

  const refreshConnections = useCallback(
    async (targetConnections: UsageConnection[]) => {
      if (targetConnections.length === 0) return;

      markConnectionsLoading(targetConnections);
      await Promise.allSettled(
        targetConnections.map((conn) => fetchQuota(conn.id, conn.provider, { force: true }))
      );
    },
    [fetchQuota, markConnectionsLoading]
  );

  const refreshAll = useCallback(async () => {
    if (refreshingAll) return;

    setRefreshingAll(true);
    setCountdown(120);
    try {
      markConnectionsLoading(connections.filter(isUsageConnection));
      const conns = await fetchConnections();
      const usageConnections = conns.filter(isUsageConnection);
      await refreshConnections(usageConnections);
    } catch (error) {
      console.error("Error refreshing all:", error);
    } finally {
      setRefreshingAll(false);
    }
  }, [
    refreshingAll,
    connections,
    fetchConnections,
    isUsageConnection,
    markConnectionsLoading,
    refreshConnections,
  ]);

  useEffect(() => {
    let isActive = true;

    const init = async () => {
      setInitialLoading(true);
      const conns = await fetchConnections();
      if (!isActive) return;

      const usageConnections = conns.filter(isUsageConnection);
      markConnectionsLoading(usageConnections);
      setInitialLoading(false);

      void refreshConnections(usageConnections);
    };

    void init();

    return () => {
      isActive = false;
    };
  }, [fetchConnections, isUsageConnection, markConnectionsLoading, refreshConnections]);

  useEffect(() => {
    if (!autoRefresh) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (countdownRef.current) clearInterval(countdownRef.current);
      return;
    }

    intervalRef.current = setInterval(refreshAll, REFRESH_INTERVAL_MS);
    countdownRef.current = setInterval(() => {
      setCountdown((prev) => (prev <= 1 ? 120 : prev - 1));
    }, 1000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, [autoRefresh, refreshAll]);

  useEffect(() => {
    const handler = () => {
      if (document.hidden) {
        if (intervalRef.current) clearInterval(intervalRef.current);
        if (countdownRef.current) clearInterval(countdownRef.current);
        return;
      }

      if (autoRefresh) {
        intervalRef.current = setInterval(refreshAll, REFRESH_INTERVAL_MS);
        countdownRef.current = setInterval(() => {
          setCountdown((prev) => (prev <= 1 ? 120 : prev - 1));
        }, 1000);
      }
    };

    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, [autoRefresh, refreshAll]);

  const filteredConnections = useMemo(
    () => connections.filter(isUsageConnection),
    [connections, isUsageConnection]
  );

  const sortedConnections = useMemo(() => {
    const priority: Record<string, number> = {
      antigravity: 1,
      github: 2,
      codex: 3,
      claude: 4,
      kiro: 5,
      glm: 6,
      "kimi-coding": 7,
    };

    return [...filteredConnections].sort(
      (a, b) => (priority[a.provider] || 9) - (priority[b.provider] || 9)
    );
  }, [filteredConnections]);

  const tierByConnection = useMemo<Record<string, TierMeta>>(() => {
    const next: Record<string, TierMeta> = {};
    for (const connection of sortedConnections) {
      next[connection.id] = normalizePlanTier(quotaData[connection.id]?.plan);
    }
    return next;
  }, [sortedConnections, quotaData]);

  const tierCounts = useMemo<Record<TierFilterKey, number>>(() => {
    const counts: Record<TierFilterKey, number> = {
      all: sortedConnections.length,
      enterprise: 0,
      team: 0,
      business: 0,
      ultra: 0,
      pro: 0,
      plus: 0,
      free: 0,
      unknown: 0,
    };

    for (const connection of sortedConnections) {
      const tierKey = (tierByConnection[connection.id]?.key || "unknown") as TierFilterKey;
      counts[tierKey] = (counts[tierKey] || 0) + 1;
    }

    return counts;
  }, [sortedConnections, tierByConnection]);

  const visibleConnections = useMemo(() => {
    if (tierFilter === "all") return sortedConnections;
    return sortedConnections.filter(
      (conn) => (tierByConnection[conn.id]?.key || "unknown") === tierFilter
    );
  }, [sortedConnections, tierByConnection, tierFilter]);

  const groupedSections = useMemo(
    () =>
      buildUsageSections({
        groupBy,
        connections: visibleConnections,
        quotaData,
        errors,
        t,
      }),
    [groupBy, visibleConnections, quotaData, errors, t]
  );

  const handleSetGroupBy = useCallback((value: LimitsGroupBy) => {
    setGroupBy(value);
    localStorage.setItem(LS_GROUP_BY, value);
  }, []);

  const toggleGroup = useCallback((groupName: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      next.has(groupName) ? next.delete(groupName) : next.add(groupName);
      localStorage.setItem(LS_EXPANDED_GROUPS, JSON.stringify([...next]));
      return next;
    });
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const hasSaved = localStorage.getItem(LS_GROUP_BY) !== null;
    if (hasSaved) return;

    if (connections.some((connection) => connection.group)) {
      setGroupBy("environment");
      return;
    }

    setGroupBy("type");
  }, [connections]);

  useEffect(() => {
    if (groupBy === "none" || !groupedSections) return;
    if (expandedGroups.size === 0) {
      const allGroups = new Set(groupedSections.map((section) => section.id));
      setExpandedGroups(allGroups);
      localStorage.setItem(LS_EXPANDED_GROUPS, JSON.stringify([...allGroups]));
    }
  }, [groupBy, groupedSections]); // eslint-disable-line react-hooks/exhaustive-deps

  if (initialLoading) {
    return (
      <div className="flex flex-col gap-4">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  if (sortedConnections.length === 0) {
    return (
      <Card padding="lg">
        <div className="text-center py-12">
          <span className="material-symbols-outlined text-[64px] opacity-15">cloud_off</span>
          <h3 className="mt-4 text-lg font-semibold text-text-main">{t("noProviders")}</h3>
          <p className="mt-2 text-sm text-text-muted max-w-[400px] mx-auto">
            {getI18nOrFallback(
              t,
              "connectProvidersForSupportedUsage",
              "Connect OAuth or supported compatible API key providers to track quota and balance."
            )}
          </p>
        </div>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-text-main m-0">{t("providerLimits")}</h2>
          <span className="text-[13px] text-text-muted">
            {t("accountsCount", { count: visibleConnections.length })}
            {visibleConnections.length !== sortedConnections.length &&
              ` ${t("filteredFromCount", { count: sortedConnections.length })}`}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border border-white/[0.08] overflow-hidden">
            <button
              onClick={() => handleSetGroupBy("none")}
              className="px-2.5 py-1.5 text-[12px] font-medium cursor-pointer border-none"
              style={{
                background: groupBy === "none" ? "rgba(255,255,255,0.1)" : "transparent",
                color: groupBy === "none" ? "var(--text-main)" : "var(--text-muted)",
              }}
            >
              {t("viewFlat")}
            </button>
            <button
              onClick={() => handleSetGroupBy("type")}
              className="px-2.5 py-1.5 text-[12px] font-medium cursor-pointer border-none border-l border-white/[0.08]"
              style={{
                background: groupBy === "type" ? "rgba(255,255,255,0.1)" : "transparent",
                color: groupBy === "type" ? "var(--text-main)" : "var(--text-muted)",
                borderLeft: "1px solid rgba(255,255,255,0.08)",
              }}
            >
              {getI18nOrFallback(t, "viewByType", "By Type")}
            </button>
            <button
              onClick={() => handleSetGroupBy("environment")}
              className="px-2.5 py-1.5 text-[12px] font-medium cursor-pointer border-none border-l border-white/[0.08]"
              style={{
                background: groupBy === "environment" ? "rgba(255,255,255,0.1)" : "transparent",
                color: groupBy === "environment" ? "var(--text-main)" : "var(--text-muted)",
                borderLeft: "1px solid rgba(255,255,255,0.08)",
              }}
            >
              {t("viewByEnvironment")}
            </button>
          </div>

          <button
            onClick={() => {
              const next = !autoRefresh;
              setAutoRefresh(next);
              localStorage.setItem(LS_AUTO_REFRESH, String(next));
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/[0.08] bg-transparent cursor-pointer text-text-main text-[13px]"
          >
            <span
              className="material-symbols-outlined text-[18px]"
              style={{ color: autoRefresh ? "#22c55e" : "var(--text-muted)" }}
            >
              {autoRefresh ? "toggle_on" : "toggle_off"}
            </span>
            {t("autoRefresh")}
            {autoRefresh && <span className="text-xs text-text-muted">({countdown}s)</span>}
          </button>

          <button
            onClick={refreshAll}
            disabled={refreshingAll}
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-white/[0.06] border border-white/10 text-text-main text-[13px] disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
          >
            <span
              className={`material-symbols-outlined text-[16px] ${
                refreshingAll ? "animate-spin" : ""
              }`}
            >
              refresh
            </span>
            {t("refreshAll")}
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        {TIER_FILTERS.map((tier) => {
          if (tier.key !== "all" && !tierCounts[tier.key]) return null;
          const active = tierFilter === tier.key;

          return (
            <button
              key={tier.key}
              onClick={() => setTierFilter(tier.key)}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold cursor-pointer"
              style={{
                border: active
                  ? "1px solid var(--primary, #E54D5E)"
                  : "1px solid rgba(255,255,255,0.12)",
                background: active ? "rgba(249,120,21,0.14)" : "transparent",
                color: active ? "var(--primary, #E54D5E)" : "var(--text-muted)",
              }}
            >
              <span>{t(tier.labelKey)}</span>
              <span className="opacity-85">{tierCounts[tier.key] || 0}</span>
            </button>
          );
        })}
      </div>

      <Card padding="none" className="overflow-hidden rounded-2xl">
        <div
          className="items-center px-4 py-2.5 border-b border-black/5 dark:border-white/5 bg-black/[0.02] dark:bg-white/[0.02] text-[11px] font-semibold uppercase tracking-wider text-text-muted"
          style={{ display: "grid", gridTemplateColumns: TABLE_GRID_COLUMNS }}
        >
          <div>{t("account")}</div>
          <div>{getI18nOrFallback(t, "quotaAndBalance", "Usage")}</div>
          <div className="text-center">{t("lastUsed")}</div>
          <div className="text-center">{t("actions")}</div>
        </div>

        {groupedSections
          ? groupedSections.map((section) => (
              <div
                key={section.id}
                className="mx-3 my-3 border border-black/5 dark:border-white/5 rounded-xl overflow-hidden bg-black/[0.01] dark:bg-white/[0.01]"
              >
                <button
                  onClick={() => toggleGroup(section.id)}
                  className="w-full flex items-center gap-2 px-4 py-2.5 bg-black/[0.02] dark:bg-white/[0.02] hover:bg-black/[0.04] dark:hover:bg-white/[0.04] transition-colors text-left border-none cursor-pointer"
                >
                  <span className="material-symbols-outlined text-[16px] text-text-muted">
                    {expandedGroups.has(section.id) ? "expand_less" : "expand_more"}
                  </span>
                  <span className="material-symbols-outlined text-[16px] text-text-muted">
                    {section.icon}
                  </span>
                  <span className="text-[12px] font-semibold text-text-main uppercase tracking-wider flex-1">
                    {section.label}
                  </span>
                  <span className="text-[11px] text-text-muted bg-surface/80 border border-black/5 dark:border-white/5 px-2 py-0.5 rounded-full">
                    {section.connections.length}
                  </span>
                </button>
                {expandedGroups.has(section.id) && (
                  <div>
                    {section.connections.map((connection, index) => (
                      <ProviderUsageRow
                        key={connection.id}
                        connection={connection}
                        tierMeta={tierByConnection[connection.id] || normalizePlanTier(null)}
                        usageEntry={quotaData[connection.id]}
                        isLoading={Boolean(loading[connection.id])}
                        error={errors[connection.id]}
                        locale={locale}
                        t={t}
                        tableGridColumns={TABLE_GRID_COLUMNS}
                        isLast={index === section.connections.length - 1}
                        onRefresh={refreshProvider}
                      />
                    ))}
                  </div>
                )}
              </div>
            ))
          : visibleConnections.map((connection, index) => (
              <ProviderUsageRow
                key={connection.id}
                connection={connection}
                tierMeta={tierByConnection[connection.id] || normalizePlanTier(null)}
                usageEntry={quotaData[connection.id]}
                isLoading={Boolean(loading[connection.id])}
                error={errors[connection.id]}
                locale={locale}
                t={t}
                tableGridColumns={TABLE_GRID_COLUMNS}
                isLast={index === visibleConnections.length - 1}
                onRefresh={refreshProvider}
              />
            ))}

        {visibleConnections.length === 0 && (
          <div className="py-6 px-4 text-center text-text-muted text-[13px]">
            {t("noAccountsForTierFilter")}{" "}
            <strong>
              {t(TIER_FILTERS.find((tier) => tier.key === tierFilter)?.labelKey || "tierUnknown")}
            </strong>
            .
          </div>
        )}
      </Card>
    </div>
  );
}
