import {
  createContext,
  useContext,
  onCleanup,
  createEffect,
  on,
  type ParentProps,
} from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useBasePath } from "./base-path"

/**
 * Alert priority: permission (highest) > question > busy
 */
export type AlertKind = "permission" | "question" | "busy"

export interface ProjectAlerts {
  /** Number of sessions with pending permission requests */
  permissions: number
  /** Number of sessions with pending questions */
  questions: number
  /** Number of sessions that are busy/retrying */
  busy: number
}

interface GlobalEventsContextValue {
  /** Alert counts per directory (keyed by worktree path) */
  alerts: Record<string, ProjectAlerts>
  /** Computed highest-priority kind + total count for a directory */
  badge: (directory: string) => { kind: AlertKind; count: number } | undefined
}

const GlobalEventsContext = createContext<GlobalEventsContextValue>()

/**
 * Manages lightweight SSE connections for inactive projects so we can
 * display alert badges on their sidebar avatars.
 *
 * The active project is excluded — it already has its own EventProvider.
 */
export function GlobalEventsProvider(props: ParentProps & {
  projects: () => { worktree: string }[]
  activeDirectory: () => string | undefined
}) {
  const { prefix } = useBasePath()

  // Per-directory alert state
  const [alerts, setAlerts] = createStore<Record<string, ProjectAlerts>>({})

  // Map of directory → SSE connection
  const connections = new Map<string, { source: EventSource; timer: ReturnType<typeof setTimeout> | null }>()

  // Per-directory tracking sets for deduplication
  const perDir = new Map<string, {
    permissionSessions: Set<string>
    questionSessions: Set<string>
    busySessions: Set<string>
  }>()

  function getTracking(dir: string) {
    const existing = perDir.get(dir)
    if (existing) return existing
    const tracking = {
      permissionSessions: new Set<string>(),
      questionSessions: new Set<string>(),
      busySessions: new Set<string>(),
    }
    perDir.set(dir, tracking)
    return tracking
  }

  function recalcAlerts(dir: string) {
    const tracking = perDir.get(dir)
    if (!tracking) return
    setAlerts(dir, {
      permissions: tracking.permissionSessions.size,
      questions: tracking.questionSessions.size,
      busy: tracking.busySessions.size,
    })
  }

  function connectToDirectory(dir: string) {
    if (connections.has(dir)) return

    const dirParam = `?directory=${encodeURIComponent(dir)}`
    const url = prefix(`/event${dirParam}`)
    const source = new EventSource(url)

    const conn = { source, timer: null as ReturnType<typeof setTimeout> | null }
    connections.set(dir, conn)

    // Seed initial state from REST endpoints
    seedDirectory(dir)

    source.onmessage = (e) => {
      const data = (() => { try { return JSON.parse(e.data) } catch { return null } })()
      if (!data) return
      const event = data?.payload ?? data
      if (!event?.type) return

      const tracking = getTracking(dir)

      if (event.type === "permission.asked") {
        const sid = (event.properties as { sessionID?: string })?.sessionID
        if (sid) {
          tracking.permissionSessions.add(sid)
          recalcAlerts(dir)
        }
        return
      }

      if (event.type === "permission.replied") {
        // A permission was answered — re-seed to get accurate count
        // (we don't know if the session has more pending permissions)
        seedPermissions(dir)
        return
      }

      if (event.type === "question.asked") {
        const sid = (event.properties as { sessionID?: string })?.sessionID
        if (sid) {
          tracking.questionSessions.add(sid)
          recalcAlerts(dir)
        }
        return
      }

      if (event.type === "question.replied" || event.type === "question.rejected") {
        const sid = (event.properties as { sessionID?: string })?.sessionID
        if (sid) {
          tracking.questionSessions.delete(sid)
          recalcAlerts(dir)
        }
        return
      }

      if (event.type === "session.status") {
        const props = event.properties as { sessionID?: string; status?: { type?: string } }
        const sid = props?.sessionID
        const type = props?.status?.type
        if (!sid || !type) return

        if (type === "busy" || type === "retry") {
          tracking.busySessions.add(sid)
        }
        if (type === "idle") {
          tracking.busySessions.delete(sid)
        }
        recalcAlerts(dir)
      }
    }

    source.onerror = () => {
      source.close()
      connections.delete(dir)
      // Reconnect after delay
      if (!conn.timer) {
        conn.timer = setTimeout(() => {
          conn.timer = null
          // Only reconnect if we still want this directory
          const active = props.activeDirectory()
          const wanted = props.projects().some((p) => p.worktree === dir)
          if (wanted && dir !== active) {
            connectToDirectory(dir)
          }
        }, 5000)
      }
    }
  }

  function disconnectDirectory(dir: string) {
    const conn = connections.get(dir)
    if (conn) {
      conn.source.close()
      if (conn.timer) clearTimeout(conn.timer)
      connections.delete(dir)
    }
    perDir.delete(dir)
    setAlerts(produce((draft) => { delete draft[dir] }))
  }

  // Seed permission/question/status state from REST for a directory
  function seedDirectory(dir: string) {
    seedPermissions(dir)
    seedQuestions(dir)
    seedStatuses(dir)
  }

  function seedPermissions(dir: string) {
    const tracking = getTracking(dir)
    fetch(prefix(`/permission?directory=${encodeURIComponent(dir)}`))
      .then((r) => r.json())
      .then((data) => {
        const perms = Array.isArray(data) ? data : (data?.data ?? [])
        tracking.permissionSessions.clear()
        for (const p of perms) {
          if (p?.sessionID) tracking.permissionSessions.add(p.sessionID)
        }
        recalcAlerts(dir)
      })
      .catch(() => {})
  }

  function seedQuestions(dir: string) {
    const tracking = getTracking(dir)
    fetch(prefix(`/question?directory=${encodeURIComponent(dir)}`))
      .then((r) => r.json())
      .then((data) => {
        const questions = Array.isArray(data) ? data : (data?.data ?? [])
        tracking.questionSessions.clear()
        for (const q of questions) {
          if (q?.sessionID) tracking.questionSessions.add(q.sessionID)
        }
        recalcAlerts(dir)
      })
      .catch(() => {})
  }

  function seedStatuses(dir: string) {
    const tracking = getTracking(dir)
    fetch(prefix(`/session/status?directory=${encodeURIComponent(dir)}`))
      .then((r) => r.json())
      .then((data) => {
        const statuses = (data?.data ?? data ?? {}) as Record<string, { type?: string }>
        tracking.busySessions.clear()
        for (const [sid, s] of Object.entries(statuses)) {
          if (s?.type === "busy" || s?.type === "retry") {
            tracking.busySessions.add(sid)
          }
        }
        recalcAlerts(dir)
      })
      .catch(() => {})
  }

  // Reactively manage connections when projects or active directory change.
  // Active project is excluded — it has its own EventProvider.
  createEffect(on(
    () => ({ dirs: props.projects().map((p) => p.worktree), active: props.activeDirectory() }),
    (current) => {
      const wanted = new Set(current.dirs)
      if (current.active) wanted.delete(current.active)

      // Disconnect directories we no longer need (including newly-active project)
      for (const dir of [...connections.keys()]) {
        if (!wanted.has(dir)) {
          disconnectDirectory(dir)
        }
      }

      // Connect to new inactive directories
      for (const dir of wanted) {
        if (!connections.has(dir)) {
          connectToDirectory(dir)
        }
      }
    },
  ))

  onCleanup(() => {
    for (const dir of [...connections.keys()]) {
      disconnectDirectory(dir)
    }
  })

  function badge(directory: string) {
    const a = alerts[directory]
    if (!a) return undefined
    const total = a.permissions + a.questions + a.busy
    if (total === 0) return undefined

    const kind: AlertKind = a.permissions > 0 ? "permission" : a.questions > 0 ? "question" : "busy"
    return { kind, count: total }
  }

  return (
    <GlobalEventsContext.Provider value={{ alerts, badge }}>
      {props.children}
    </GlobalEventsContext.Provider>
  )
}

export function useGlobalEvents() {
  const ctx = useContext(GlobalEventsContext)
  if (!ctx) throw new Error("useGlobalEvents must be used within GlobalEventsProvider")
  return ctx
}
