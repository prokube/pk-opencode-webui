import { onCleanup } from "solid-js"
import { useBrowserNotifications } from "./browser-notifications"
import { useSDK } from "./sdk"
import { useSync } from "./sync"

const ALERT_CAP = 1000

export function BrowserNotificationEvents() {
  const notifications = useBrowserNotifications()
  const sdk = useSDK()
  const sync = useSync()
  const alerted = new Set<string>()
  const errors = new Set<string>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  function title(sessionID?: string) {
    if (!sessionID) return "OpenCode session"
    return sync.session.get(sessionID)?.title ?? sessionID
  }

  function alert(key: string, run: () => void) {
    if (alerted.has(key)) return
    alerted.add(key)
    if (alerted.size > ALERT_CAP) Array.from(alerted).slice(0, ALERT_CAP / 2).forEach((item) => alerted.delete(item))
    run()
  }

  const unsub = sync.subscribe((event) => {
    const directory = sdk.directory
    if (!directory) return
    if (event.type === "session.status" && event.properties.status.type !== "idle") {
      const sessionID = event.properties.sessionID
      alerted.delete(`idle:${sessionID}`)
      errors.delete(sessionID)
      const timer = timers.get(sessionID)
      if (timer) clearTimeout(timer)
      timers.delete(sessionID)
      return
    }
    if (event.type === "session.idle") {
      const sessionID = event.properties.sessionID
      if (sync.session.get(sessionID)?.parentID || timers.has(sessionID)) return
      const timer = setTimeout(() => {
        timers.delete(sessionID)
        if (errors.delete(sessionID)) return
        alert(`idle:${sessionID}`, () => notifications.notify("agent", "Response ready", title(sessionID), directory, sessionID, `opencode:idle:${directory}:${sessionID}`))
      }, 250)
      timers.set(sessionID, timer)
      return
    }
    if (event.type === "session.error") {
      const sessionID = event.properties.sessionID
      if (!sessionID) return
      if (sync.session.get(sessionID)?.parentID) return
      errors.add(sessionID)
      if (event.properties.error?.name === "MessageAbortedError") return
      notifications.notify("errors", "Session error", title(sessionID), directory, sessionID, `opencode:error:${directory}:${sessionID}`)
      return
    }
    if (event.type === "question.asked") {
      const request = event.properties
      alert(`question:${request.id}`, () => notifications.notify("agent", "Question", `${title(request.sessionID)} has a question`, directory, request.sessionID, `opencode:question:${directory}:${request.id}`))
      return
    }
    if (event.type !== "permission.asked") return
    const request = event.properties
    const key = `permission:${request.id}`
    const timer = setTimeout(() => {
      timers.delete(key)
      if (!sync.pendingPermissions[request.id]) return
      alert(key, () => notifications.notify("permissions", "Permission required", `${title(request.sessionID)} needs permission`, directory, request.sessionID, `opencode:permission:${directory}:${request.id}`))
    }, 0)
    timers.set(key, timer)
  })

  onCleanup(() => {
    unsub()
    timers.forEach(clearTimeout)
  })
  return null
}
