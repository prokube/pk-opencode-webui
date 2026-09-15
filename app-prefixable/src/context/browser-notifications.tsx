import { createContext, createSignal, onCleanup, onMount, useContext, type ParentProps } from "solid-js"
import { useBasePath } from "./base-path"
import { base64Encode } from "../utils/path"
import {
  DEFAULT_BROWSER_NOTIFICATION_SETTINGS,
  initialBrowserNotificationSettings,
  legacyBrowserEnabled,
  parseBrowserNotificationSettings,
  parseLegacyNotificationMap,
  shouldShowBrowserNotification,
  type BrowserNotificationSettings,
} from "../utils/browser-notifications"

const STORAGE_KEY = "opencode.browserNotifications"
const NOTIFIED_KEY = "opencode.browserNotifications.delivered"
const LEGACY_NOTIFY_KEY = "opencode.sessionNotify"
const LEGACY_CHANNELS_KEY = "opencode.alarmChannels"
interface BrowserNotificationsContextValue {
  supported: () => boolean
  permission: () => NotificationPermission | "unsupported"
  settings: () => BrowserNotificationSettings
  request: () => Promise<NotificationPermission | "unsupported">
  set: (key: keyof BrowserNotificationSettings, enabled: boolean) => void
  legacyCount: () => number
  clearLegacy: () => void
  notify: (category: keyof BrowserNotificationSettings, title: string, body: string, directory: string, sessionID?: string, tag?: string, preferenceSessionID?: string) => boolean
}

const BrowserNotificationsContext = createContext<BrowserNotificationsContextValue>()

export function BrowserNotificationsProvider(props: ParentProps) {
  const { prefix } = useBasePath()
  const supported = () => typeof window !== "undefined" && "Notification" in window
  const [permission, setPermission] = createSignal<NotificationPermission | "unsupported">("unsupported")
  const [settings, setSettings] = createSignal(DEFAULT_BROWSER_NOTIFICATION_SETTINGS)
  const [legacy, setLegacy] = createSignal<Record<string, boolean>>({})
  const [legacyBrowser, setLegacyBrowser] = createSignal(true)
  const [configured, setConfigured] = createSignal(false)

  function persist(next: BrowserNotificationSettings) {
    setConfigured(true)
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
      const stored = localStorage.getItem(STORAGE_KEY)
      const previous = parseLegacyNotificationMap(localStorage.getItem(LEGACY_NOTIFY_KEY))
      const channelRaw = localStorage.getItem(LEGACY_CHANNELS_KEY)
      const browser = legacyBrowserEnabled(channelRaw)
      setConfigured(!!stored)
      setLegacy(previous)
      setLegacyBrowser(browser)
      setSettings(initialBrowserNotificationSettings(stored, previous, browser, channelRaw !== null))
    } catch {
      setSettings(DEFAULT_BROWSER_NOTIFICATION_SETTINGS)
    }
    const refreshPermission = () => setPermission(supported() ? Notification.permission : "unsupported")
    const syncSettings = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) {
        setConfigured(event.newValue !== null)
        setSettings(parseBrowserNotificationSettings(event.newValue))
      }
      if (event.key === LEGACY_NOTIFY_KEY) {
        setLegacy(parseLegacyNotificationMap(event.newValue))
        if (!configured()) setSettings({ agent: false, permissions: false, errors: false })
      }
      if (event.key === LEGACY_CHANNELS_KEY) {
        setLegacyBrowser(legacyBrowserEnabled(event.newValue))
        if (!configured()) setSettings({ agent: false, permissions: false, errors: false })
      }
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
    legacyCount: () => Object.keys(legacy()).length,
    clearLegacy: () => {
      setLegacy({})
      try {
        localStorage.removeItem(LEGACY_NOTIFY_KEY)
      } catch {
        // The in-memory preference still takes effect for this tab.
      }
    },
    notify: (category, title, body, directory, sessionID, tag, preferenceSessionID) => {
      const target = preferenceSessionID ?? sessionID
      const legacyEnabled = category !== "errors" && legacyBrowser() && !!target && (legacy()[`${directory}::${target}`] === true || legacy()[target] === true)
      if ((!settings()[category] && !legacyEnabled) || !supported()) return false
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
      }).catch(deliver)
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
