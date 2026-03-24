"use client";

import { useTranslations } from "next-intl";

import { useState, useEffect, useCallback } from "react";
import { Card } from "@/shared/components";

type LockoutEntry = {
  key?: string;
  scope?: "account" | "model";
  provider?: string;
  providerDisplayName?: string;
  connectionId?: string;
  accountName?: string;
  scopedModelName?: string;
  reason?: string | null;
  remainingMs?: number;
};

export default function RateLimitStatus() {
  const t = useTranslations("usage");
  const tc = useTranslations("common");
  const [data, setData] = useState<{ lockouts: LockoutEntry[]; cacheStats: unknown | null }>({
    lockouts: [],
    cacheStats: null,
  });

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/rate-limits");
      if (res.ok) setData(await res.json());
    } catch {}
  }, []);

  useEffect(() => {
    const initialLoad = setTimeout(() => {
      void load();
    }, 0);
    const interval = setInterval(() => {
      void load();
    }, 10000);
    return () => {
      clearTimeout(initialLoad);
      clearInterval(interval);
    };
  }, [load]);

  const formatMs = (ms: number) => {
    if (ms < 1000) return t("durationMillisecondsShort", { value: ms });
    if (ms < 60000) return t("durationSecondsShort", { value: Math.ceil(ms / 1000) });
    return t("durationMinutesShort", { value: Math.ceil(ms / 60000) });
  };

  return (
    <div className="flex flex-col gap-4">
      {/* {t("modelLockouts")} */}
      <Card>
        <div className="flex items-center gap-3 mb-4">
          <div className="p-2 rounded-lg bg-orange-500/10 text-orange-500">
            <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
              lock_clock
            </span>
          </div>
          <div className="flex-1">
            <h3 className="text-lg font-semibold">{t("modelLockouts")}</h3>
            <p className="text-sm text-text-muted">{t("lockoutsAutoRefreshHint")}</p>
          </div>
          {data.lockouts.length > 0 && (
            <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-orange-500/10 text-orange-400 border border-orange-500/20">
              {t("lockedCount", { count: data.lockouts.length })}
            </span>
          )}
        </div>

        {data.lockouts.length === 0 ? (
          <div className="text-center py-6 text-text-muted">
            <span
              className="material-symbols-outlined text-[32px] mb-2 block opacity-40"
              aria-hidden="true"
            >
              lock_open
            </span>
            <p className="text-sm">{t("noLockouts")}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {data.lockouts.map((lock, i) => (
              <div
                key={lock.key || `${lock.connectionId || lock.provider || "lockout"}:${i}`}
                className="flex items-center justify-between px-3 py-2.5 rounded-lg
                           bg-orange-500/5 border border-orange-500/15"
              >
                <div className="flex items-center gap-3">
                  <span
                    className="material-symbols-outlined text-[16px] text-orange-400"
                    aria-hidden="true"
                  >
                    {lock.scope === "account" ? "lock_person" : "lock"}
                  </span>
                  <div>
                    <p className="text-sm font-medium break-all">
                      {lock.scopedModelName ||
                        lock.providerDisplayName ||
                        lock.provider ||
                        tc("unknown")}
                    </p>
                    <p className="text-xs text-text-muted">
                      {lock.scope === "account" ? (
                        <>
                          <span className="font-medium">
                            {lock.providerDisplayName || lock.provider || tc("unknown")}
                          </span>
                          {lock.accountName && lock.accountName !== lock.providerDisplayName && (
                            <>
                              {t("reasonSeparator")}
                              {t("account")}:{" "}
                              <span className="font-medium">{lock.accountName}</span>
                            </>
                          )}
                        </>
                      ) : (
                        <>
                          {t("account")}:{" "}
                          <span className="font-medium">{lock.accountName || tc("none")}</span>
                        </>
                      )}
                      {lock.connectionId && (
                        <>
                          {t("reasonSeparator")}
                          <span className="font-mono">{lock.connectionId.slice(0, 12)}</span>
                        </>
                      )}
                      {lock.reason && (
                        <>
                          {t("reasonSeparator")}
                          {lock.reason}
                        </>
                      )}
                    </p>
                  </div>
                </div>
                <span className="text-xs font-mono tabular-nums text-orange-400">
                  {t("timeLeft", { time: formatMs(lock.remainingMs || 0) })}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
