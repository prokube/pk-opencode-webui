/** Shared helpers for the per-session notification toggle stored in localStorage */

import { dispatchStorageEvent } from "./storage"

export const NOTIFY_STORAGE_KEY = "opencode.sessionNotify";
export const ALARM_CHANNELS_STORAGE_KEY = "opencode.alarmChannels";

export type AlarmChannels = {
  browser: boolean
  telegram: boolean
}

const DEFAULT_ALARM_CHANNELS: AlarmChannels = {
  browser: true,
  telegram: false,
}

/** Read the per-session notification toggle map from localStorage */
export function readNotifyMap(): Record<string, boolean> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(NOTIFY_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, boolean>;
    if (!parsed || typeof parsed !== "object") {
      window.localStorage.removeItem(NOTIFY_STORAGE_KEY);
      return {};
    }
    return parsed;
  } catch {
    try { window.localStorage.removeItem(NOTIFY_STORAGE_KEY); } catch {}
    return {};
  }
}

/** Write the per-session notification toggle map to localStorage and dispatch
 *  a synthetic storage event so same-tab listeners update immediately. */
export function writeNotifyMap(map: Record<string, boolean>) {
  if (typeof window === "undefined") return;
  const value = JSON.stringify(map);
  try {
    window.localStorage.setItem(NOTIFY_STORAGE_KEY, value);
  } catch {
    return; // If write failed, no point notifying listeners
  }
  dispatchStorageEvent(NOTIFY_STORAGE_KEY, value);
}

/** Remove a session's entry from the notification toggle map */
export function cleanupNotifyState(id: string) {
  const map = readNotifyMap();
  if (!(id in map)) return;
  delete map[id];
  writeNotifyMap(map);
}

export function readAlarmChannels(): AlarmChannels {
  if (typeof window === "undefined") return DEFAULT_ALARM_CHANNELS;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(ALARM_CHANNELS_STORAGE_KEY);
  } catch {
    return DEFAULT_ALARM_CHANNELS;
  }
  if (!raw) return DEFAULT_ALARM_CHANNELS;
  let parsed: Partial<AlarmChannels> | null = null;
  try {
    parsed = JSON.parse(raw) as Partial<AlarmChannels> | null;
  } catch {
    try { window.localStorage.removeItem(ALARM_CHANNELS_STORAGE_KEY); } catch {}
    return DEFAULT_ALARM_CHANNELS;
  }
  if (!parsed || typeof parsed !== "object") {
    try { window.localStorage.removeItem(ALARM_CHANNELS_STORAGE_KEY); } catch {}
    return DEFAULT_ALARM_CHANNELS;
  }
  return {
    browser: parsed.browser !== false,
    telegram: parsed.telegram === true,
  };
}

export function writeAlarmChannels(channels: AlarmChannels) {
  if (typeof window === "undefined") return;
  const value = JSON.stringify(channels);
  try {
    window.localStorage.setItem(ALARM_CHANNELS_STORAGE_KEY, value);
  } catch {
    return;
  }
  dispatchStorageEvent(ALARM_CHANNELS_STORAGE_KEY, value);
}
