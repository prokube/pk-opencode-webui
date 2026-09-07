/**
 * Dispatch a synthetic StorageEvent for same-tab listeners.
 * Native storage events only fire cross-tab, so we must dispatch manually.
 * Includes a fallback for environments that don't support StorageEvent construction.
 */
export function dispatchStorageEvent(key: string, value: string | null) {
  if (typeof window === "undefined") return
  try {
    window.dispatchEvent(new StorageEvent("storage", {
      key,
      newValue: value,
      storageArea: localStorage,
    }))
  } catch {
    try {
      const fallback = new CustomEvent("storage", { detail: { key, newValue: value } })
      Object.defineProperty(fallback, "key", { value: key })
      Object.defineProperty(fallback, "newValue", { value })
      window.dispatchEvent(fallback)
    } catch { /* ignore */ }
  }
}

function encodeScope(value: string) {
  return encodeURIComponent(value)
}

export function serverStorageKey(serverId: string, name: string) {
  return `opencode.server.${encodeScope(serverId)}.${name}`
}

export function workspaceStorageKey(serverId: string, directory: string, name: string) {
  return `opencode.server.${encodeScope(serverId)}.workspace.${encodeScope(directory)}.${name}`
}

export function legacyStorageValue(
  serverId: string,
  current: string | null,
  legacy: readonly (string | null)[],
  validate: (value: string) => boolean,
) {
  if (current !== null) return { value: current, migrated: false }
  if (serverId !== "local") return { value: null, migrated: false }
  const value = legacy.find((item): item is string => item !== null && validate(item))
  return value === undefined
    ? { value: null, migrated: false }
    : { value, migrated: true }
}
