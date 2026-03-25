"use client";

import { useEffect, useState } from "react";
import { Button, Card, Input } from "@/shared/components";
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

export default function SystemTimeZoneCard() {
  const t = useTranslations("settings");
  const tApi = useTranslations("apiManager");
  const tc = useTranslations("common");
  const { timeZone, hostTimeZone, loading, saveTimeZone } = useSystemTimeZone();
  const [timeZoneInput, setTimeZoneInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<"" | "saved" | "error">("");
  const title =
    typeof t.has === "function" && t.has("systemTimezone")
      ? t("systemTimezone")
      : "Internal timezone";
  const hint =
    typeof t.has === "function" && t.has("systemTimezoneHint")
      ? t("systemTimezoneHint")
      : "Only affects internal calculations when a provider-specific timezone is not set. It does not change dashboard timestamp display.";
  const description =
    hostTimeZone && typeof t.has === "function" && t.has("systemTimezoneDesc")
      ? t("systemTimezoneDesc", { timeZone: hostTimeZone })
      : hostTimeZone
        ? `Use a fixed fallback timezone for internal date logic such as inferred reset windows. Leave blank to follow this host (${hostTimeZone}).`
        : hint;
  const followHostLabel =
    typeof t.has === "function" && t.has("followSystemTimezone")
      ? t("followSystemTimezone")
      : "Follow host timezone";
  const invalidTimeZoneMessage =
    typeof t.has === "function" && t.has("invalidTimezone")
      ? t("invalidTimezone")
      : "Enter a valid IANA timezone such as Asia/Shanghai.";

  const normalizedTimeZoneInput = normalizeTimeZone(timeZoneInput);
  const timeZoneDirty = normalizedTimeZoneInput !== timeZone;
  const timeZoneError =
    normalizedTimeZoneInput.length > 0 && !isValidTimeZone(normalizedTimeZoneInput)
      ? invalidTimeZoneMessage
      : "";

  useEffect(() => {
    setTimeZoneInput(timeZone);
  }, [timeZone]);

  const handleSaveTimeZone = async () => {
    if (timeZoneError) return;

    const nextTimeZone = normalizeTimeZone(timeZoneInput);
    setSaving(true);
    setStatus("");

    try {
      const nextState = await saveTimeZone(nextTimeZone);
      setTimeZoneInput(nextState.timeZone);
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
        <Input
          label={tApi("scheduleTimezone")}
          value={timeZoneInput}
          onChange={(e) => {
            setTimeZoneInput(e.target.value);
            setStatus("");
          }}
          placeholder={hostTimeZone || undefined}
          hint={hint}
          error={timeZoneError || undefined}
          list="system-timezone-suggestions"
          disabled={loading || saving}
        />

        <datalist id="system-timezone-suggestions">
          {COMMON_TIME_ZONES.map((timeZone) => (
            <option key={timeZone} value={timeZone} />
          ))}
        </datalist>

        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setTimeZoneInput("");
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
