/** Shared helpers for the per-session notification toggle stored in localStorage */

export const NOTIFY_STORAGE_KEY = "opencode.sessionNotify";

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
  // Dispatch a synthetic StorageEvent for same-tab listeners (native storage events only fire cross-tab)
  try {
    window.dispatchEvent(new StorageEvent("storage", {
      key: NOTIFY_STORAGE_KEY,
      newValue: value,
      storageArea: window.localStorage,
    }));
  } catch {
    // Fallback for environments that don't support StorageEvent construction
    try { window.dispatchEvent(new CustomEvent("storage", { detail: { key: NOTIFY_STORAGE_KEY } })); } catch {}
  }
}

/** Remove a session's entry from the notification toggle map */
export function cleanupNotifyState(id: string) {
  const map = readNotifyMap();
  if (!(id in map)) return;
  delete map[id];
  writeNotifyMap(map);
}
