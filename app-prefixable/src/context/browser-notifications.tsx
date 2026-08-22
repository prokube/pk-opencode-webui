import { createContext, createSignal, onCleanup, onMount, useContext, type ParentProps } from "solid-js"
import { useBasePath } from "./base-path"
import { base64Encode } from "../utils/path"
import {
  DEFAULT_BROWSER_NOTIFICATION_SETTINGS,
  parseBrowserNotificationSettings,
  shouldShowBrowserNotification,
  type BrowserNotificationSettings,
} from "../utils/browser-notifications"

const STORAGE_KEY = "opencode.browserNotifications"
const NOTIFIED_KEY = "opencode.browserNotifications.delivered"
interface BrowserNotificationsContextValue {
  supported: () => boolean
  permission: () => NotificationPermission | "unsupported"
  settings: () => BrowserNotificationSettings
  request: () => Promise<NotificationPermission | "unsupported">
  set: (key: keyof BrowserNotificationSettings, enabled: boolean) => void
  notify: (category: keyof BrowserNotificationSettings, title: string, body: string, directory: string, sessionID?: string, tag?: string) => boolean
}

const BrowserNotificationsContext = createContext<BrowserNotificationsContextValue>()

export function BrowserNotificationsProvider(props: ParentProps) {
  const { prefix } = useBasePath()
  const supported = () => typeof window !== "undefined" && "Notification" in window
  const [permission, setPermission] = createSignal<NotificationPermission | "unsupported">("unsupported")
  const [settings, setSettings] = createSignal(DEFAULT_BROWSER_NOTIFICATION_SETTINGS)

  function persist(next: BrowserNotificationSettings) {
    setSettings(next)
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch {
      // Preferences remain active for this tab when storage is unavailable.
    }
  }

  function claim(tag: string) {
    try {
      const now = Date.now()
      const parsed = JSON.parse(localStorage.getItem(NOTIFIED_KEY) ?? "{}") as Record<string, number>
      if (now - (parsed[tag] ?? 0) < 10_000) return false
      const recent = Object.fromEntries(Object.entries(parsed).filter(([, time]) => now - time < 60_000))
      localStorage.setItem(NOTIFIED_KEY, JSON.stringify({ ...recent, [tag]: now }))
      return true
    } catch {
      return true
    }
  }

  onMount(() => {
    setPermission(supported() ? Notification.permission : "unsupported")
    try {
      setSettings(parseBrowserNotificationSettings(localStorage.getItem(STORAGE_KEY)))
    } catch {
      setSettings(DEFAULT_BROWSER_NOTIFICATION_SETTINGS)
    }
    const refreshPermission = () => setPermission(supported() ? Notification.permission : "unsupported")
    const syncSettings = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY) return
      setSettings(parseBrowserNotificationSettings(event.newValue))
    }
    window.addEventListener("focus", refreshPermission)
    window.addEventListener("storage", syncSettings)
    onCleanup(() => {
      window.removeEventListener("focus", refreshPermission)
      window.removeEventListener("storage", syncSettings)
    })
  })

  const value: BrowserNotificationsContextValue = {
    supported,
    permission,
    settings,
    request: async () => {
      if (!supported()) return "unsupported"
      const next = await Notification.requestPermission().catch(() => Notification.permission)
      setPermission(next)
      return next
    },
    set: (key, enabled) => persist({ ...settings(), [key]: enabled }),
    notify: (category, title, body, directory, sessionID, tag) => {
      if (!settings()[category] || !supported()) return false
      if (!shouldShowBrowserNotification(Notification.permission, document.visibilityState, document.hasFocus())) return false
      const deliver = () => {
        if (tag && !claim(tag)) return
        try {
          const notification = new Notification(title, { body, icon: prefix("/favicon.svg"), tag })
          notification.onclick = () => {
            window.focus()
            const route = `/${base64Encode(directory)}/session${sessionID ? `/${sessionID}` : ""}`
            window.location.assign(prefix(route))
            notification.close()
          }
        } catch {
          // Browser permission may have changed between the permission check and delivery.
        }
      }
      if (!tag || !navigator.locks) deliver()
      if (tag && navigator.locks) void navigator.locks.request(`opencode-notification:${tag}`, { ifAvailable: true }, (lock) => {
        if (lock) deliver()
      })
      return true
    },
  }

  return <BrowserNotificationsContext.Provider value={value}>{props.children}</BrowserNotificationsContext.Provider>
}

export function useBrowserNotifications() {
  const context = useContext(BrowserNotificationsContext)
  if (!context) throw new Error("useBrowserNotifications must be used within BrowserNotificationsProvider")
  return context
}
