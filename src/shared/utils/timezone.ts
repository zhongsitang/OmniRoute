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
  const timeZone = isValidTimeZone(preferredTimeZone)
    ? preferredTimeZone.trim()
    : getCurrentTimeZone();
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
