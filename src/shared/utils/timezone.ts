export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.trim().length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value.trim() }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function getCurrentTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export type TimeZoneOption = {
  value: string;
  label: string;
};

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

export function normalizeTimeZone(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function getSupportedTimeZones(): string[] {
  const intlWithSupportedValuesOf = Intl as typeof Intl & {
    supportedValuesOf?: (key: "timeZone") => string[];
  };

  if (typeof intlWithSupportedValuesOf.supportedValuesOf === "function") {
    return intlWithSupportedValuesOf.supportedValuesOf("timeZone");
  }

  return COMMON_TIME_ZONES;
}

export function resolvePreferredTimeZone(
  preferredTimeZone: unknown,
  fallbackTimeZone?: unknown
): string {
  const normalized = normalizeTimeZone(preferredTimeZone);
  if (isValidTimeZone(normalized)) return normalized;

  const fallback = normalizeTimeZone(fallbackTimeZone);
  return isValidTimeZone(fallback) ? fallback : getCurrentTimeZone();
}

export function formatInTimeZone(
  value: string | number | Date,
  locale?: string,
  preferredTimeZone?: unknown,
  options: Intl.DateTimeFormatOptions = {}
): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";

  try {
    const timeZone = resolvePreferredTimeZone(preferredTimeZone);
    const formatterOptions: Intl.DateTimeFormatOptions =
      "dateStyle" in options || "timeStyle" in options
        ? { ...options, timeZone }
        : { dateStyle: "medium", timeStyle: "short", ...options, timeZone };
    return new Intl.DateTimeFormat(locale, formatterOptions).format(date);
  } catch {
    return date.toLocaleString(locale);
  }
}

function getTimeZoneDateParts(
  timeZone: string,
  date: Date
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} | null {
  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const parts = formatter.formatToParts(date);
    const values = Object.fromEntries(
      parts
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, Number.parseInt(part.value, 10)])
    ) as Record<string, number>;

    return {
      year: values.year,
      month: values.month,
      day: values.day,
      hour: values.hour === 24 ? 0 : values.hour,
      minute: values.minute,
      second: values.second,
    };
  } catch {
    return null;
  }
}

function getTimeZoneOffsetMs(timeZone: string, utcMs: number): number | null {
  const parts = getTimeZoneDateParts(timeZone, new Date(utcMs));
  if (!parts) return null;

  const interpretedUtcMs = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );

  return interpretedUtcMs - utcMs;
}

function formatTimeZoneOffsetLabel(timeZone: string, now = new Date()): string {
  const offsetMs = getTimeZoneOffsetMs(timeZone, now.getTime());
  if (offsetMs === null) return "UTC";

  const totalMinutes = Math.round(offsetMs / 60000);
  const sign = totalMinutes >= 0 ? "+" : "-";
  const absoluteMinutes = Math.abs(totalMinutes);
  const hours = String(Math.floor(absoluteMinutes / 60)).padStart(2, "0");
  const minutes = String(absoluteMinutes % 60).padStart(2, "0");

  return `UTC${sign}${hours}:${minutes}`;
}

export function formatTimeZoneDisplayName(value: unknown): string {
  const timeZone = normalizeTimeZone(value);
  if (!isValidTimeZone(timeZone)) return timeZone;

  const locationLabel =
    timeZone === "UTC"
      ? "UTC"
      : timeZone
          .split("/")
          .slice(1)
          .map((part) => part.replace(/_/g, " "))
          .join(" / ") || timeZone.replace(/_/g, " ");
  const offsetLabel = formatTimeZoneOffsetLabel(timeZone);

  if (locationLabel === timeZone) {
    return `${locationLabel} (${offsetLabel})`;
  }

  return `${locationLabel} (${timeZone}, ${offsetLabel})`;
}

export function buildTimeZoneOptions(preferredTimeZones: unknown[] = []): TimeZoneOption[] {
  const seen = new Set<string>();

  return [...preferredTimeZones, ...COMMON_TIME_ZONES, ...getSupportedTimeZones()]
    .map((value) => normalizeTimeZone(value))
    .filter((value) => {
      if (!value || seen.has(value) || !isValidTimeZone(value)) return false;
      seen.add(value);
      return true;
    })
    .map((value) => ({
      value,
      label: formatTimeZoneDisplayName(value),
    }));
}

function getUtcForTimeZoneLocalMidnight(
  timeZone: string,
  year: number,
  month: number,
  day: number
): string | null {
  const targetUtcMs = Date.UTC(year, month - 1, day, 0, 0, 0);
  let guessMs = targetUtcMs;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const offsetMs = getTimeZoneOffsetMs(timeZone, guessMs);
    if (offsetMs === null) return null;

    const adjustedMs = targetUtcMs - offsetMs;
    if (Math.abs(adjustedMs - guessMs) < 1000) {
      guessMs = adjustedMs;
      break;
    }
    guessMs = adjustedMs;
  }

  return new Date(guessMs).toISOString();
}

export function getNextDailyResetAt(preferredTimeZone: unknown, now = new Date()): string | null {
  const timeZone = resolvePreferredTimeZone(preferredTimeZone);
  const localParts = getTimeZoneDateParts(timeZone, now);
  if (!localParts) return null;

  const nextDay = new Date(Date.UTC(localParts.year, localParts.month - 1, localParts.day + 1));

  return getUtcForTimeZoneLocalMidnight(
    timeZone,
    nextDay.getUTCFullYear(),
    nextDay.getUTCMonth() + 1,
    nextDay.getUTCDate()
  );
}
