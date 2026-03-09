/** Shared helpers for the per-session notification toggle stored in localStorage */

import { dispatchStorageEvent } from "./storage"
import type { Session } from "../sdk/client"

export const NOTIFY_STORAGE_KEY = "opencode.sessionNotify";

function isRootSession(session: Session | null | undefined) {
  return !!session && !session.parentID;
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

/** Read whether notifications are enabled for a root session. Child sessions never inherit notification state. */
export function isSessionNotifyEnabled(session: Session | null | undefined) {
  if (!isRootSession(session)) return false;
  return readNotifyMap()[session.id] === true;
}

/** Update notification state for a root session. Child sessions are ignored. */
export function setSessionNotifyEnabled(session: Session | null | undefined, enabled: boolean) {
  if (!isRootSession(session)) return;
  const map = readNotifyMap();
  if (enabled) map[session.id] = true;
  else delete map[session.id];
  writeNotifyMap(map);
}

/** Remove a session's entry from the notification toggle map */
export function cleanupNotifyState(id: string) {
  const map = readNotifyMap();
  if (!(id in map)) return;
  delete map[id];
  writeNotifyMap(map);
}
