"use client";

import { useEffect, useState } from "react";
import { Button, Card, Select } from "@/shared/components";
import { useSystemTimeZone } from "@/shared/hooks/useSystemTimeZone";
import { isValidTimeZone, normalizeTimeZone } from "@/shared/utils/timezone";
import { useTranslations } from "next-intl";

const COMMON_TIME_ZONES = [
  "UTC",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Europe/Berlin",
  "Europe/London",
  "America/New_York",
  "America/Los_Angeles",
  "Australia/Sydney",
];

type TimeZoneOption = {
  value: string;
  label: string;
};

const getSupportedTimeZones = (): string[] => {
  const intlWithSupportedValuesOf = Intl as typeof Intl & {
    supportedValuesOf?: (key: "timeZone") => string[];
  };

  if (typeof intlWithSupportedValuesOf.supportedValuesOf === "function") {
    return intlWithSupportedValuesOf.supportedValuesOf("timeZone");
  }

  return COMMON_TIME_ZONES;
};
const SUPPORTED_TIME_ZONES = getSupportedTimeZones();

function buildTimeZoneOptions(currentTimeZone: string, hostTimeZone: string): TimeZoneOption[] {
  const seen = new Set<string>();
  const orderedTimeZones = [
    currentTimeZone,
    hostTimeZone,
    ...COMMON_TIME_ZONES,
    ...SUPPORTED_TIME_ZONES,
  ]
    .map((value) => normalizeTimeZone(value))
    .filter((value) => {
      if (!value || seen.has(value) || !isValidTimeZone(value)) return false;
      seen.add(value);
      return true;
    });

  return orderedTimeZones.map((value) => ({
    value,
    label: value,
  }));
}

export default function SystemTimeZoneCard() {
  const t = useTranslations("settings");
  const tApi = useTranslations("apiManager");
  const tc = useTranslations("common");
  const { timeZone, hostTimeZone, loading, saveTimeZone } = useSystemTimeZone();
  const [selectedTimeZone, setSelectedTimeZone] = useState("");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<"" | "saved" | "error">("");
  const title =
    typeof t.has === "function" && t.has("systemTimezone")
      ? t("systemTimezone")
      : "System Timezone";
  const hint =
    typeof t.has === "function" && t.has("systemTimezoneHint")
      ? t("systemTimezoneHint")
      : "Does not change the timestamps shown in the dashboard.";
  const description =
    typeof t.has === "function" && t.has("systemTimezoneDesc")
      ? t("systemTimezoneDesc", { timeZone: hostTimeZone })
      : "Used for daily resets, refresh windows, and similar internal schedule rules.";
  const followHostLabel =
    typeof t.has === "function" && t.has("followSystemTimezone")
      ? t("followSystemTimezone")
      : "Use server timezone";
  const invalidTimeZoneMessage =
    typeof t.has === "function" && t.has("invalidTimezone")
      ? t("invalidTimezone")
      : "Enter a valid timezone, for example Asia/Shanghai.";

  const timeZoneOptions = buildTimeZoneOptions(timeZone, hostTimeZone);
  const normalizedTimeZoneInput = normalizeTimeZone(selectedTimeZone);
  const timeZoneDirty = normalizedTimeZoneInput !== timeZone;
  const timeZoneError =
    normalizedTimeZoneInput.length > 0 && !isValidTimeZone(normalizedTimeZoneInput)
      ? invalidTimeZoneMessage
      : "";

  useEffect(() => {
    setSelectedTimeZone(timeZone);
  }, [timeZone]);

  const handleSaveTimeZone = async () => {
    if (timeZoneError) return;

    const nextTimeZone = normalizedTimeZoneInput;
    setSaving(true);
    setStatus("");

    try {
      const nextState = await saveTimeZone(nextTimeZone);
      setSelectedTimeZone(nextState.timeZone);
      setStatus("saved");
      setTimeout(() => setStatus(""), 2000);
    } catch (err) {
      console.error("Failed to update timeZone:", err);
      setStatus("error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <div className="flex items-center gap-3 mb-4">
        <div className="p-2 rounded-lg bg-sky-500/10 text-sky-500">
          <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
            schedule
          </span>
        </div>
        <div>
          <h3 className="text-lg font-semibold">{title}</h3>
          <p className="text-sm text-text-muted">{description}</p>
        </div>
      </div>

      <div className="flex flex-col gap-4">
        <Select
          label={tApi("scheduleTimezone")}
          value={selectedTimeZone}
          onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
            setSelectedTimeZone(e.target.value);
            setStatus("");
          }}
          options={timeZoneOptions}
          placeholder={hostTimeZone ? `${followHostLabel} (${hostTimeZone})` : followHostLabel}
          hint={hint}
          error={timeZoneError || undefined}
          disabled={loading || saving}
        />

        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setSelectedTimeZone("");
              setStatus("");
            }}
            disabled={loading || saving}
          >
            {followHostLabel}
          </Button>
          <Button
            size="sm"
            onClick={handleSaveTimeZone}
            loading={saving}
            disabled={loading || !timeZoneDirty || Boolean(timeZoneError)}
          >
            {tc("save")}
          </Button>
          {status === "saved" && (
            <span className="text-xs font-medium text-emerald-500 flex items-center gap-1">
              <span className="material-symbols-outlined text-[14px]">check_circle</span>
              {t("saved")}
            </span>
          )}
          {status === "error" && <span className="text-xs text-red-500">{t("errorOccurred")}</span>}
        </div>
      </div>
    </Card>
  );
}
