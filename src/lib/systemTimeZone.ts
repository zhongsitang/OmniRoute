import { getCachedSettings } from "@/lib/db/readCache";
import {
  getCurrentTimeZone,
  normalizeTimeZone,
  resolvePreferredTimeZone,
} from "@/shared/utils/timezone";

type SettingsLike = {
  timeZone?: unknown;
};

export type SystemTimeZoneSnapshot = {
  timeZone: string;
  hostTimeZone: string;
  resolvedTimeZone: string;
};

export function getHostTimeZone(): string {
  return getCurrentTimeZone();
}

export function buildSystemTimeZoneSnapshot(settings?: SettingsLike): SystemTimeZoneSnapshot {
  const timeZone = normalizeTimeZone(settings?.timeZone);
  const hostTimeZone = getHostTimeZone();

  return {
    timeZone,
    hostTimeZone,
    resolvedTimeZone: resolvePreferredTimeZone(timeZone, hostTimeZone),
  };
}

export async function resolveSystemTimeZone(preferredTimeZone?: unknown): Promise<string> {
  const settings = await getCachedSettings();
  const { resolvedTimeZone } = buildSystemTimeZoneSnapshot(settings);
  return resolvePreferredTimeZone(preferredTimeZone, resolvedTimeZone);
}
