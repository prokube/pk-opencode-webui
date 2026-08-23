export interface BrowserNotificationSettings {
  agent: boolean
  permissions: boolean
  errors: boolean
}

export const DEFAULT_BROWSER_NOTIFICATION_SETTINGS: BrowserNotificationSettings = {
  agent: true,
  permissions: true,
  errors: false,
}

export function parseBrowserNotificationSettings(value: string | null): BrowserNotificationSettings {
  if (!value) return DEFAULT_BROWSER_NOTIFICATION_SETTINGS
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    return {
      agent: typeof parsed.agent === "boolean" ? parsed.agent : DEFAULT_BROWSER_NOTIFICATION_SETTINGS.agent,
      permissions: typeof parsed.permissions === "boolean" ? parsed.permissions : DEFAULT_BROWSER_NOTIFICATION_SETTINGS.permissions,
      errors: typeof parsed.errors === "boolean" ? parsed.errors : DEFAULT_BROWSER_NOTIFICATION_SETTINGS.errors,
    }
  } catch {
    return DEFAULT_BROWSER_NOTIFICATION_SETTINGS
  }
}

export function parseLegacyNotificationMap(raw: string | null) {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== "object") return {}
    return Object.fromEntries(Object.entries(parsed).filter(([, enabled]) => enabled === true).map(([key]) => [key, true])) as Record<string, boolean>
  } catch {
    return {}
  }
}

export function legacyBrowserEnabled(raw: string | null) {
  if (raw === null) return true
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false
    const browser = (parsed as Record<string, unknown>).browser
    if (browser !== undefined && typeof browser !== "boolean") return false
    return browser !== false
  } catch {
    return false
  }
}

export function initialBrowserNotificationSettings(stored: string | null, legacy: Record<string, boolean>, legacyBrowser = true, legacyConfigured = false) {
  if (stored) return parseBrowserNotificationSettings(stored)
  if (!legacyBrowser || legacyConfigured) return { agent: false, permissions: false, errors: false }
  if (Object.keys(legacy).length) return { agent: false, permissions: false, errors: false }
  return DEFAULT_BROWSER_NOTIFICATION_SETTINGS
}

export function shouldShowBrowserNotification(permission: NotificationPermission, visibility: DocumentVisibilityState, focused: boolean) {
  return permission === "granted" && (visibility !== "visible" || !focused)
}
