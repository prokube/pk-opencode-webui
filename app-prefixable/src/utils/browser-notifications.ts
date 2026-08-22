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

export function shouldShowBrowserNotification(permission: NotificationPermission, visibility: DocumentVisibilityState, focused: boolean) {
  return permission === "granted" && (visibility !== "visible" || !focused)
}
