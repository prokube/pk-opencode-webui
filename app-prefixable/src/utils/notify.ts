/** Shared helpers for the per-session notification toggle stored in localStorage */

import { dispatchStorageEvent } from "./storage"

export const NOTIFY_STORAGE_KEY = "opencode.sessionNotify";
export const ALARM_CHANNELS_STORAGE_KEY = "opencode.alarmChannels";

export type AlarmChannels = {
  browser: boolean
  telegram: boolean
}

export function notifySessionKey(id: string, directory?: string) {
  const dir = directory?.trim()
  if (!dir) return id
  return `${dir}::${id}`
}

export function notifyEnabledForSession(map: Record<string, boolean>, id: string, directory?: string) {
  const key = notifySessionKey(id, directory)
  if (map[key] === true) return true
  return map[id] === true
}

export function migrateNotifySessionKey(map: Record<string, boolean>, id: string, directory?: string) {
  const key = notifySessionKey(id, directory)
  if (key === id) return false
  if (map[id] !== true) return false
  map[key] = true
  delete map[id]
  return true
}

export function writeNotifySessionEnabled(
  map: Record<string, boolean>,
  id: string,
  enabled: boolean,
  directory?: string,
) {
  const key = notifySessionKey(id, directory)
  if (enabled) {
    map[key] = true
    if (key !== id) delete map[id]
    return
  }
  delete map[key]
  delete map[id]
}

const DEFAULT_ALARM_CHANNELS: AlarmChannels = {
  browser: true,
  telegram: false,
}

function defaultAlarmChannels(): AlarmChannels {
  return { ...DEFAULT_ALARM_CHANNELS }
}

function removeStorageKey(key: string) {
  try {
    window.localStorage.removeItem(key)
  } catch {
    return
  }
}

/** Read the per-session notification toggle map from localStorage */
export function readNotifyMap(): Record<string, boolean> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(NOTIFY_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, boolean>;
    if (!parsed || typeof parsed !== "object") {
      removeStorageKey(NOTIFY_STORAGE_KEY);
      return {};
    }
    return parsed;
  } catch {
    removeStorageKey(NOTIFY_STORAGE_KEY)
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
export function cleanupNotifyState(id: string, directory?: string) {
  const map = readNotifyMap();
  const key = notifySessionKey(id, directory)
  if (!(id in map) && !(key in map)) return;
  delete map[id];
  delete map[key]
  writeNotifyMap(map);
}

export function readAlarmChannels(): AlarmChannels {
  if (typeof window === "undefined") return defaultAlarmChannels();
  const raw = (() => {
    try {
      return window.localStorage.getItem(ALARM_CHANNELS_STORAGE_KEY)
    } catch {
      return null
    }
  })();
  if (raw === null) {
    return defaultAlarmChannels();
  }
  if (!raw) return defaultAlarmChannels();
  try {
    const parsed = JSON.parse(raw) as Partial<AlarmChannels> | null;
    if (!parsed || typeof parsed !== "object") {
      removeStorageKey(ALARM_CHANNELS_STORAGE_KEY)
      return defaultAlarmChannels();
    }
    return {
      browser: parsed.browser !== false,
      telegram: parsed.telegram === true,
    };
  } catch {
    removeStorageKey(ALARM_CHANNELS_STORAGE_KEY)
    return defaultAlarmChannels();
  }
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
