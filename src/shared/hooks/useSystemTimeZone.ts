"use client";

import { useCallback, useEffect, useState } from "react";
import { normalizeTimeZone } from "@/shared/utils/timezone";

type SettingsPayload = {
  timeZone?: string;
  hostTimeZone?: string;
  resolvedTimeZone?: string;
};

type SystemTimeZoneState = {
  timeZone: string;
  hostTimeZone: string;
  resolvedTimeZone: string;
};

const emptyState: SystemTimeZoneState = {
  timeZone: "",
  hostTimeZone: "",
  resolvedTimeZone: "",
};

let cachedState: SystemTimeZoneState | null = null;
let pendingStateRequest: Promise<SystemTimeZoneState> | null = null;

const listeners = new Set<(state: SystemTimeZoneState) => void>();

function toSystemTimeZoneState(data: SettingsPayload | null | undefined): SystemTimeZoneState {
  const timeZone = normalizeTimeZone(data?.timeZone);
  const hostTimeZone = normalizeTimeZone(data?.hostTimeZone);

  return {
    timeZone,
    hostTimeZone,
    resolvedTimeZone: normalizeTimeZone(data?.resolvedTimeZone) || hostTimeZone,
  };
}

function publishSystemTimeZoneState(nextState: SystemTimeZoneState): SystemTimeZoneState {
  cachedState = nextState;
  listeners.forEach((listener) => listener(nextState));
  return nextState;
}

async function fetchSystemTimeZoneState(force = false): Promise<SystemTimeZoneState> {
  if (!force && cachedState) return cachedState;
  if (!force && pendingStateRequest) return pendingStateRequest;

  pendingStateRequest = fetch("/api/settings")
    .then(async (res) => {
      if (!res.ok) {
        throw new Error(`HTTP error ${res.status}`);
      }
      return toSystemTimeZoneState(await res.json());
    })
    .then((nextState) => publishSystemTimeZoneState(nextState))
    .finally(() => {
      pendingStateRequest = null;
    });

  return pendingStateRequest;
}

async function saveSystemTimeZone(timeZone: unknown): Promise<SystemTimeZoneState> {
  const normalizedTimeZone = normalizeTimeZone(timeZone);
  const res = await fetch("/api/settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ timeZone: normalizedTimeZone }),
  });

  if (!res.ok) {
    throw new Error(`HTTP error ${res.status}`);
  }

  return publishSystemTimeZoneState(toSystemTimeZoneState(await res.json()));
}

export function useSystemTimeZone() {
  const [state, setState] = useState<SystemTimeZoneState>(cachedState ?? emptyState);
  const [loading, setLoading] = useState(cachedState === null);

  useEffect(() => {
    let active = true;

    const handleStateChange = (nextState: SystemTimeZoneState) => {
      if (!active) return;
      setState(nextState);
      setLoading(false);
    };

    listeners.add(handleStateChange);

    if (cachedState) {
      handleStateChange(cachedState);
    } else {
      fetchSystemTimeZoneState().catch(() => {
        if (!active) return;
        setLoading(false);
      });
    }

    return () => {
      active = false;
      listeners.delete(handleStateChange);
    };
  }, []);

  const saveTimeZone = useCallback((timeZone: unknown) => saveSystemTimeZone(timeZone), []);

  return {
    ...state,
    loading,
    saveTimeZone,
  };
}
