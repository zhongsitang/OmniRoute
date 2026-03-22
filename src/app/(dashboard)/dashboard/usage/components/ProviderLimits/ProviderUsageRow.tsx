"use client";

import Image from "next/image";
import Link from "next/link";
import Badge from "@/shared/components/Badge";
import { Skeleton } from "@/shared/components/Loading";
import ProviderUsageContent from "./ProviderUsageContent";
import {
  formatLastUsed,
  getProviderMeta,
  type NormalizedPlanTier,
  type ProviderConnectionSummary,
  type ProviderUsageEntry,
  type UsageTranslateFn,
} from "./utils";

type ProviderUsageRowProps = {
  connection: ProviderConnectionSummary;
  tierMeta: NormalizedPlanTier;
  usageEntry?: ProviderUsageEntry;
  isLoading: boolean;
  error?: string | null;
  locale: string;
  t: UsageTranslateFn;
  tableGridColumns: string;
  isLast: boolean;
  onRefresh: (connectionId: string, provider: string) => void | Promise<void>;
};

export default function ProviderUsageRow({
  connection,
  tierMeta,
  usageEntry,
  isLoading,
  error,
  locale,
  t,
  tableGridColumns,
  isLast,
  onRefresh,
}: ProviderUsageRowProps) {
  const providerMeta = getProviderMeta(connection);
  const accountLabel = connection.name || providerMeta.label;
  const providerLabel = providerMeta.providerKind;
  const providerHref = `/dashboard/providers/${encodeURIComponent(connection.provider)}`;
  const lastUsedText = formatLastUsed(connection.lastUsedAt, t, locale);
  const showLoadingSkeleton = isLoading && !usageEntry && !error;

  if (showLoadingSkeleton) {
    return (
      <div
        className={`items-center px-4 py-3.5 ${
          !isLast ? "border-b border-black/[0.04] dark:border-white/[0.05]" : ""
        }`}
        style={{ display: "grid", gridTemplateColumns: tableGridColumns }}
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <Skeleton className="size-8 rounded-lg shrink-0" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-28 max-w-[80%]" />
            <div className="flex items-center gap-1.5">
              <Skeleton className="h-5 w-14 rounded-full" />
              <Skeleton className="h-3 w-20 max-w-[45%]" />
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-x-3 gap-y-2 pr-3">
          <div className="min-w-[220px] shrink-0">
            <div className="flex items-center gap-1.5">
              <Skeleton className="h-6 w-16 rounded" />
              <Skeleton className="h-1.5 flex-1 min-w-[120px] rounded-sm" />
              <Skeleton className="h-3 w-10" />
            </div>
          </div>
          <div className="min-w-[120px] shrink-0">
            <div className="flex items-center gap-2">
              <Skeleton className="h-5 w-20 rounded" />
              <Skeleton className="h-3 w-16" />
            </div>
          </div>
        </div>

        <div className="flex justify-center">
          <Skeleton className="h-3 w-14" />
        </div>

        <div className="flex justify-center">
          <Skeleton className="size-6 rounded-md" />
        </div>
      </div>
    );
  }

  return (
    <div
      className={`items-center px-4 py-3.5 transition-[background] duration-150 hover:bg-black/[0.02] dark:hover:bg-white/[0.02] ${
        !isLast ? "border-b border-black/[0.04] dark:border-white/[0.05]" : ""
      }`}
      style={{ display: "grid", gridTemplateColumns: tableGridColumns }}
    >
      <Link
        href={providerHref}
        className="group/link flex items-center gap-2.5 min-w-0 rounded-lg -mx-1 px-1 py-1.5 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35"
        title={accountLabel}
      >
        <div className="w-8 h-8 rounded-lg flex items-center justify-center overflow-hidden shrink-0">
          <Image
            src={providerMeta.iconSrc}
            alt={providerMeta.label}
            width={32}
            height={32}
            className="object-contain"
            sizes="32px"
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-text-main truncate">{accountLabel}</div>
          <div className="flex items-center gap-1.5 mt-0.5">
            {tierMeta.key !== "unknown" && (
              <span
                title={
                  usageEntry?.plan
                    ? t("rawPlanWithValue", { plan: usageEntry.plan })
                    : t("noPlanFromProvider")
                }
              >
                <Badge variant={tierMeta.variant} size="sm" dot>
                  {tierMeta.label}
                </Badge>
              </span>
            )}
            <span className="text-[11px] text-text-muted truncate">{providerLabel}</span>
          </div>
        </div>
      </Link>

      <div className="flex flex-wrap gap-x-3 gap-y-1.5 pr-3">
        <ProviderUsageContent
          connection={connection}
          usageEntry={usageEntry}
          isLoading={isLoading}
          error={error}
          locale={locale}
          t={t}
        />
      </div>

      <div className="text-center text-[11px] text-text-muted">
        <span title={connection.lastUsedAt || ""}>{lastUsedText}</span>
      </div>

      <div className="flex justify-center gap-0.5">
        <button
          onClick={() => onRefresh(connection.id, connection.provider)}
          disabled={isLoading}
          title={t("refreshQuota")}
          className="p-1 rounded-md border-none bg-transparent cursor-pointer disabled:cursor-not-allowed disabled:opacity-30 opacity-60 hover:opacity-100 flex items-center justify-center transition-opacity duration-150"
        >
          <span
            className={`material-symbols-outlined text-[16px] text-text-muted ${
              isLoading ? "animate-spin" : ""
            }`}
          >
            refresh
          </span>
        </button>
      </div>
    </div>
  );
}
