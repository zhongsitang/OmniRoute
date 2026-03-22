"use client";

import {
  calculatePercentage,
  formatCountdownLabel,
  getBalanceDisplayState,
  getBarColor,
  getCompactUsageStatusLabel,
  getShortModelName,
  hasUsageMessageOnly,
  type ProviderConnectionSummary,
  type ProviderUsageEntry,
  type UsageTranslateFn,
} from "./utils";

type ProviderUsageContentProps = {
  connection: ProviderConnectionSummary;
  usageEntry?: ProviderUsageEntry;
  isLoading: boolean;
  error?: string | null;
  locale: string;
  t: UsageTranslateFn;
};

type UsageMeterProps = {
  label: string;
  countdownText?: string | null;
  progressText: string;
  barFillWidth: string;
  barFillColor: string;
  textColor: string;
  bgColor: string;
  minIndicatorWidth?: string;
};

type UsageLabelPillProps = {
  label: string;
  bgColor: string;
  textColor: string;
};

type UsageMetaPillProps = {
  label: string;
};

function UsageLabelPill({ label, bgColor, textColor }: UsageLabelPillProps) {
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center whitespace-nowrap min-w-[60px] rounded px-2 py-0.5 text-[11px] font-semibold text-center"
      style={{ background: bgColor, color: textColor }}
    >
      {label}
    </span>
  );
}

function UsageMetaPill({ label }: UsageMetaPillProps) {
  return (
    <span className="inline-flex max-w-full items-center rounded bg-black/[0.03] px-2 py-0.5 text-[10px] font-medium leading-4 text-text-muted dark:bg-white/[0.04] [overflow-wrap:anywhere]">
      {label}
    </span>
  );
}

function UsageMeter({
  label,
  countdownText,
  progressText,
  barFillWidth,
  barFillColor,
  textColor,
  bgColor,
  minIndicatorWidth = "60px",
}: UsageMeterProps) {
  return (
    <div className="flex items-center gap-1.5 min-w-[200px] shrink-0">
      <UsageLabelPill label={label} bgColor={bgColor} textColor={textColor} />
      {countdownText && (
        <span className="text-[10px] text-text-muted whitespace-nowrap">⏱ {countdownText}</span>
      )}
      <div
        className="flex-1 h-1.5 rounded-sm bg-black/[0.05] dark:bg-white/[0.05] overflow-hidden"
        style={{ minWidth: minIndicatorWidth }}
      >
        <div
          className="h-full rounded-sm transition-[width] duration-300 ease-out"
          style={{
            width: barFillWidth,
            background: barFillColor,
          }}
        />
      </div>
      <span
        className="text-[11px] font-semibold min-w-[32px] text-right"
        style={{ color: textColor }}
      >
        {progressText}
      </span>
    </div>
  );
}

export default function ProviderUsageContent({
  connection,
  usageEntry,
  isLoading,
  error,
  locale,
  t,
}: ProviderUsageContentProps) {
  const compactErrorLabel = error ? getCompactUsageStatusLabel(t, error) : null;
  const compactMessageLabel = usageEntry?.message
    ? getCompactUsageStatusLabel(t, usageEntry.message)
    : null;
  const balanceDisplay = getBalanceDisplayState(
    usageEntry?.balance || null,
    locale,
    t,
    usageEntry?.plan
  );

  if (isLoading) {
    return (
      <div className="flex items-center gap-1.5 text-text-muted text-xs">
        <span className="material-symbols-outlined animate-spin text-[14px]">
          progress_activity
        </span>
        {t("loadingQuotas")}
      </div>
    );
  }

  if (error) {
    return (
      <div
        title={error}
        className="inline-flex items-center gap-1.5 rounded-full border border-red-500/15 bg-red-500/[0.06] px-2.5 py-1 text-[11px] text-red-500"
      >
        <span className="material-symbols-outlined text-[14px]">error</span>
        <span className="whitespace-nowrap">{compactErrorLabel}</span>
      </div>
    );
  }

  if (hasUsageMessageOnly(usageEntry)) {
    return (
      <div
        title={usageEntry?.message || undefined}
        className="inline-flex items-center gap-1.5 rounded-full border border-black/5 dark:border-white/5 bg-black/[0.02] dark:bg-white/[0.02] px-2.5 py-1 text-[11px] text-text-muted"
      >
        <span className="material-symbols-outlined text-[14px]">info</span>
        <span className="whitespace-nowrap">{compactMessageLabel}</span>
      </div>
    );
  }

  if (usageEntry?.mode === "balance" && usageEntry.balance && balanceDisplay) {
    const isWallet = usageEntry.balance.kind === "wallet";
    const hasRemainingAmount = balanceDisplay.remainingAmount !== "-";

    return (
      <div className="min-w-0 w-full flex-1 py-0.5" title={balanceDisplay.title}>
        {isWallet ? (
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
            <UsageLabelPill
              label={balanceDisplay.heading}
              bgColor={balanceDisplay.pillColors.bg}
              textColor={balanceDisplay.pillColors.text}
            />
            {hasRemainingAmount && (
              <span className="shrink-0 text-[12px] font-semibold text-text-main tabular-nums whitespace-nowrap">
                {balanceDisplay.remainingAmount}
              </span>
            )}
            {balanceDisplay.planText && <UsageMetaPill label={balanceDisplay.planText} />}
            {balanceDisplay.expiresText && (
              <span className="text-[10px] text-text-muted break-words">
                {balanceDisplay.expiresText}
              </span>
            )}
          </div>
        ) : (
          <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1.5">
            <UsageMeter
              label={balanceDisplay.heading}
              countdownText={balanceDisplay.resetText}
              progressText={balanceDisplay.percentText}
              barFillWidth={balanceDisplay.barFillWidth}
              barFillColor={balanceDisplay.barFillColor}
              textColor={balanceDisplay.progressColors.text}
              bgColor={balanceDisplay.pillColors.bg}
              minIndicatorWidth="120px"
            />
            {hasRemainingAmount && (
              <span className="shrink-0 text-[12px] font-semibold text-text-main tabular-nums whitespace-nowrap">
                {balanceDisplay.remainingAmount}
              </span>
            )}
            {balanceDisplay.planText && <UsageMetaPill label={balanceDisplay.planText} />}
            {balanceDisplay.expiresText && (
              <span className="text-[10px] text-text-muted break-words">
                {balanceDisplay.expiresText}
              </span>
            )}
          </div>
        )}
      </div>
    );
  }

  if (usageEntry?.quotas?.length) {
    return usageEntry.quotas.map((quota, index) => {
      const remaining =
        quota.remainingPercentage !== undefined
          ? Math.round(quota.remainingPercentage)
          : calculatePercentage(quota.used, quota.total);
      const colors = getBarColor(remaining);
      const countdownText = formatCountdownLabel(quota.resetAt);

      return (
        <div key={`${connection.id}-${quota.name}-${index}`} className="min-w-[200px] shrink-0">
          <UsageMeter
            label={getShortModelName(quota.name)}
            countdownText={countdownText}
            progressText={`${remaining}%`}
            barFillWidth={`${Math.min(remaining, 100)}%`}
            barFillColor={colors.bar}
            textColor={colors.text}
            bgColor={colors.bg}
          />
        </div>
      );
    });
  }

  return <div className="text-xs text-text-muted italic">{t("noQuotaData")}</div>;
}
