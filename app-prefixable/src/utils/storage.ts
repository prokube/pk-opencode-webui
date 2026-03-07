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
