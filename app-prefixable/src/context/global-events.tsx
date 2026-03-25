import {
  createContext,
  useContext,
  onCleanup,
  createEffect,
  on,
  type ParentProps,
} from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useServer } from "./server"
import { createSSEParser } from "../utils/sse"

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
  /** Total unique sessions needing attention (union, avoids double-counting) */
  totalSessions: number
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
  const { authHeaders, serverUrl, activeServer } = useServer()

  // Per-directory alert state
  const [alerts, setAlerts] = createStore<Record<string, ProjectAlerts>>({})

  // Map of directory → SSE connection (abort controller for fetch-based SSE)
  const connections = new Map<string, { controller: AbortController }>()
  let disposed = false

  // Pending reconnect timers, tracked separately from connections but cleared by disconnectDirectory
  const reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>()

  // Debounce timers for permission reseeds — prevents multiple rapid permission.replied
  // events from spawning overlapping fetch requests that race each other
  const permReseedTimers = new Map<string, ReturnType<typeof setTimeout>>()

  // Per-directory tracking sets for deduplication
  const perDir = new Map<string, {
    permissionSessions: Set<string>
    questionSessions: Set<string>
    busySessions: Set<string>
    /** Known sub-agent session IDs — events from these are ignored */
    subAgents: Set<string>
    /** Root session IDs from the initial seed — used to filter sub-agents
     *  that existed before the SSE connection started (session.created
     *  events are only observed for new sessions). Null until seeded. */
    rootSessions: Set<string> | null
  }>()

  function getTracking(dir: string) {
    const existing = perDir.get(dir)
    if (existing) return existing
    const tracking = {
      permissionSessions: new Set<string>(),
      questionSessions: new Set<string>(),
      busySessions: new Set<string>(),
      subAgents: new Set<string>(),
      rootSessions: null as Set<string> | null,
    }
    perDir.set(dir, tracking)
    return tracking
  }

  function recalcAlerts(dir: string) {
    const tracking = perDir.get(dir)
    if (!tracking) return
    // Compute union of session IDs to avoid double-counting
    const allSessions = new Set([
      ...tracking.permissionSessions,
      ...tracking.questionSessions,
      ...tracking.busySessions,
    ])
    setAlerts(dir, {
      permissions: tracking.permissionSessions.size,
      questions: tracking.questionSessions.size,
      busy: tracking.busySessions.size,
      totalSessions: allSessions.size,
    })
  }

  function connectToDirectory(dir: string) {
    if (connections.has(dir)) return
    // Don't connect when a remote server is active
    if (!activeServer().isDefault) return

    // Cancel any pending reconnect timer for this directory
    const pending = reconnectTimers.get(dir)
    if (pending) {
      clearTimeout(pending)
      reconnectTimers.delete(dir)
    }

    const dirParam = `?directory=${encodeURIComponent(dir)}`
    const url = `${serverUrl()}/event${dirParam}`
    const controller = new AbortController()

    connections.set(dir, { controller })

    // Buffer events until seed completes to avoid races where an SSE event
    // adds state, then the seed clears and repopulates (dropping the event).
    const buffer: string[] = []
    const MAX_BUFFER = 1000
    let seeded = false

    function handleMessage(rawData: string) {
      if (!seeded) {
        if (buffer.length >= MAX_BUFFER) buffer.shift()
        buffer.push(rawData)
        return
      }
      processMessage(rawData)
    }

    function processMessage(rawData: string) {
      const data = (() => { try { return JSON.parse(rawData) } catch { return null } })()
      if (!data) return
      const event = data?.payload ?? data
      if (!event?.type) return

      const tracking = getTracking(dir)

      // Track sub-agent sessions so we can exclude them from badge counts.
      // session.created includes the full Session object with parentID.
      if (event.type === "session.created") {
        const info = (event.properties as { info?: { id?: string; parentID?: string } })?.info
        if (info?.id && info?.parentID) {
          const sid = info.id
          tracking.subAgents.add(sid)
          let changed = false
          if (tracking.permissionSessions.delete(sid)) changed = true
          if (tracking.questionSessions.delete(sid)) changed = true
          if (tracking.busySessions.delete(sid)) changed = true
          if (changed) recalcAlerts(dir)
        }
        if (info?.id && !info?.parentID && tracking.rootSessions) {
          tracking.rootSessions.add(info.id)
        }
        return
      }

      if (event.type === "session.deleted") {
        const info = (event.properties as { info?: { id?: string } })?.info
        const sid = info?.id
        if (sid) {
          tracking.subAgents.delete(sid)
          let changed = false
          if (tracking.permissionSessions.delete(sid)) changed = true
          if (tracking.questionSessions.delete(sid)) changed = true
          if (tracking.busySessions.delete(sid)) changed = true
          if (changed) recalcAlerts(dir)
        }
        return
      }

      if (event.type === "permission.asked") {
        const sid = (event.properties as { sessionID?: string })?.sessionID
        if (!sid) return
        if (tracking.subAgents.has(sid)) return
        if (tracking.rootSessions && !tracking.rootSessions.has(sid)) return
        tracking.permissionSessions.add(sid)
        recalcAlerts(dir)
        return
      }

      if (event.type === "permission.replied") {
        const existing = permReseedTimers.get(dir)
        if (existing) clearTimeout(existing)
        permReseedTimers.set(dir, setTimeout(() => {
          permReseedTimers.delete(dir)
          fetchRootSessionIds(dir).then((roots) => {
            const tracking = perDir.get(dir)
            if (tracking && roots) tracking.rootSessions = roots
            seedPermissions(dir, roots)
          })
        }, 300))
        return
      }

      if (event.type === "question.asked") {
        const sid = (event.properties as { sessionID?: string })?.sessionID
        if (!sid) return
        if (tracking.subAgents.has(sid)) return
        if (tracking.rootSessions && !tracking.rootSessions.has(sid)) return
        tracking.questionSessions.add(sid)
        recalcAlerts(dir)
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
        if (tracking.subAgents.has(sid)) return
        if (tracking.rootSessions && !tracking.rootSessions.has(sid)) return

        if (type === "busy" || type === "retry") {
          tracking.busySessions.add(sid)
        }
        if (type === "idle") {
          tracking.busySessions.delete(sid)
        }
        recalcAlerts(dir)
      }
    }

    // Start fetch-based SSE with auth headers
    ;(async () => {
      try {
        const response = await fetch(url, {
          headers: { ...authHeaders(), Accept: "text/event-stream" },
          signal: controller.signal,
        })

        if (!response.ok || !response.body) {
          throw new Error(`SSE connection failed: ${response.status}`)
        }

        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        const parser = createSSEParser((data) => handleMessage(data))

        // Start reading SSE immediately (handleMessage buffers until seeded).
        // Seed runs concurrently so events arriving during seed are captured
        // under the MAX_BUFFER cap instead of accumulating unbounded in the
        // network buffer.
        seedDirectory(dir).then(() => {
          const conn = connections.get(dir)
          if (!conn || conn.controller !== controller) return
          seeded = true
          for (const buffered of buffer) processMessage(buffered)
          buffer.length = 0
        })

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          parser.push(decoder.decode(value, { stream: true }))
        }

        parser.push(decoder.decode())
        parser.push("")

        throw new Error("SSE stream ended")
      } catch (err) {
        if (controller.signal.aborted) return
        if (disposed) return
        disconnectDirectory(dir)
        const reconnectTimer = setTimeout(() => {
          reconnectTimers.delete(dir)
          if (disposed) return
          // Don't reconnect when a remote server is active — local projects don't exist there
          if (!activeServer().isDefault) return
          const active = props.activeDirectory()
          const wanted = props.projects().some((p) => p.worktree === dir)
          if (wanted && dir !== active) {
            connectToDirectory(dir)
          }
        }, 5000)
        reconnectTimers.set(dir, reconnectTimer)
      }
    })()
  }

  function disconnectDirectory(dir: string) {
    const conn = connections.get(dir)
    if (conn) {
      conn.controller.abort()
      connections.delete(dir)
    }
    const timer = reconnectTimers.get(dir)
    if (timer) {
      clearTimeout(timer)
      reconnectTimers.delete(dir)
    }
    const reseed = permReseedTimers.get(dir)
    if (reseed) {
      clearTimeout(reseed)
      permReseedTimers.delete(dir)
    }
    perDir.delete(dir)
    setAlerts(produce((draft) => { delete draft[dir] }))
  }

  // Fetch root session IDs for a directory so seed functions can filter sub-agents.
  // Returns null on failure so callers can gracefully degrade (seed all sessions)
  // instead of clearing all state with a false-negative empty set.
  function fetchRootSessionIds(dir: string): Promise<Set<string> | null> {
    return fetch(`${serverUrl()}/session?directory=${encodeURIComponent(dir)}&roots=true`, { headers: authHeaders() })
      .then((r) => {
        if (!r.ok) {
          console.warn("[GlobalEvents] Failed to fetch root sessions for", dir, `HTTP ${r.status}`)
          return null
        }
        return r.json()
      })
      .then((data) => {
        if (data === null) return null
        const sessions = Array.isArray(data) ? data : (data?.data ?? [])
        const roots = new Set<string>()
        for (const s of sessions) {
          if (s?.id) roots.add(s.id as string)
        }
        return roots
      })
      .catch((e) => {
        console.warn("[GlobalEvents] Failed to fetch root sessions for", dir, e)
        return null
      })
  }

  // Seed permission/question/status state from REST for a directory.
  // First fetches root session IDs, then seeds only root sessions.
  // Returns a promise that resolves when all seeds complete (or fail).
  async function seedDirectory(dir: string) {
    // Ensure tracking exists before any async work so the perDir.has(dir)
    // guards in seed functions correctly detect disconnection (rather than
    // failing because the entry was never created).
    const tracking = getTracking(dir)
    const roots = await fetchRootSessionIds(dir)
    if (!perDir.has(dir)) return  // disconnected while fetching

    // Store root session IDs so SSE handlers can filter pre-existing
    // sub-agents that we never saw a session.created event for.
    tracking.rootSessions = roots

    // Seed subAgents from all sessions: any session with a parentID is a
    // sub-agent. This covers sessions that existed before the SSE connection.
    if (roots) {
      await fetch(`${serverUrl()}/session?directory=${encodeURIComponent(dir)}`, { headers: authHeaders() })
        .then((r) => {
          if (!r.ok) return
          return r.json()
        })
        .then((data) => {
          if (!data || !perDir.has(dir)) return
          const all = Array.isArray(data) ? data : (data?.data ?? [])
          for (const s of all) {
            if (s?.parentID && s?.id) tracking.subAgents.add(s.id as string)
          }
        })
        .catch(() => {})
    }

    await Promise.allSettled([
      seedPermissions(dir, roots),
      seedQuestions(dir, roots),
      seedStatuses(dir, roots),
    ])
  }

  function seedPermissions(dir: string, roots: Set<string> | null) {
    const tracking = perDir.get(dir)
    if (!tracking) return  // disconnected: do not recreate tracking while seeding
    // Snapshot sessions added by SSE before the fetch started so we can
    // merge them back, avoiding a race where clear() drops concurrent events.
    const before = new Set(tracking.permissionSessions)
    return fetch(`${serverUrl()}/permission?directory=${encodeURIComponent(dir)}`, { headers: authHeaders() })
      .then((r) => r.json())
      .then((data) => {
        if (!perDir.has(dir)) return  // disconnected while fetching
        const perms = Array.isArray(data) ? data : (data?.data ?? [])
        const fetched = new Set<string>()
        for (const p of perms) {
          // When roots is null (fetch failed), accept all sessions as a
          // graceful degradation instead of clearing everything.
          if (p?.sessionID && !tracking.subAgents.has(p.sessionID) && (roots === null || roots.has(p.sessionID))) fetched.add(p.sessionID)
        }
        // Merge: use the fetched set as the base, but preserve any sessions
        // that were added by SSE events AFTER we started the fetch (i.e.,
        // sessions in current set that weren't in the pre-fetch snapshot).
        // Filter out sub-agent IDs to prevent non-root sessions from leaking in.
        const added = new Set<string>()
        for (const sid of tracking.permissionSessions) {
          if (!before.has(sid) && !tracking.subAgents.has(sid)) added.add(sid)
        }
        tracking.permissionSessions.clear()
        for (const sid of fetched) tracking.permissionSessions.add(sid)
        for (const sid of added) tracking.permissionSessions.add(sid)
        recalcAlerts(dir)
      })
      .catch((e) => console.warn("[GlobalEvents] Failed to seed permissions for", dir, e))
  }

  function seedQuestions(dir: string, roots: Set<string> | null) {
    const tracking = perDir.get(dir)
    if (!tracking) return  // disconnected: do not recreate tracking while seeding
    return fetch(`${serverUrl()}/question?directory=${encodeURIComponent(dir)}`, { headers: authHeaders() })
      .then((r) => r.json())
      .then((data) => {
        if (!perDir.has(dir)) return  // disconnected while fetching
        const questions = Array.isArray(data) ? data : (data?.data ?? [])
        tracking.questionSessions.clear()
        for (const q of questions) {
          if (q?.sessionID && !tracking.subAgents.has(q.sessionID) && (roots === null || roots.has(q.sessionID))) tracking.questionSessions.add(q.sessionID)
        }
        recalcAlerts(dir)
      })
      .catch((e) => console.warn("[GlobalEvents] Failed to seed questions for", dir, e))
  }

  function seedStatuses(dir: string, roots: Set<string> | null) {
    const tracking = perDir.get(dir)
    if (!tracking) return  // disconnected: do not recreate tracking while seeding
    return fetch(`${serverUrl()}/session/status?directory=${encodeURIComponent(dir)}`, { headers: authHeaders() })
      .then((r) => r.json())
      .then((data) => {
        if (!perDir.has(dir)) return  // disconnected while fetching
        const statuses = (data?.data ?? data ?? {}) as Record<string, { type?: string }>
        tracking.busySessions.clear()
        for (const [sid, s] of Object.entries(statuses)) {
          if (!tracking.subAgents.has(sid) && (roots === null || roots.has(sid)) && (s?.type === "busy" || s?.type === "retry")) {
            tracking.busySessions.add(sid)
          }
        }
        recalcAlerts(dir)
      })
      .catch((e) => console.warn("[GlobalEvents] Failed to seed statuses for", dir, e))
  }

  // Reactively manage connections when projects or active directory change.
  // Active project is excluded — it has its own EventProvider.
  // Remote servers are skipped — local projects don't exist on remote servers.
  createEffect(on(
    () => ({ dirs: props.projects().map((p) => p.worktree), active: props.activeDirectory(), isRemote: !activeServer().isDefault }),
    (current) => {
      // When a remote server is active, disconnect all global event connections
      // since local projects don't exist on the remote server.
      if (current.isRemote) {
        for (const dir of [...connections.keys()]) {
          disconnectDirectory(dir)
        }
        return
      }

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
    disposed = true
    for (const dir of [...connections.keys()]) {
      disconnectDirectory(dir)
    }
    // Cancel any orphaned reconnect timers (directory already disconnected but timer pending)
    for (const [, timer] of reconnectTimers) {
      clearTimeout(timer)
    }
    reconnectTimers.clear()
    for (const [, timer] of permReseedTimers) {
      clearTimeout(timer)
    }
    permReseedTimers.clear()
  })

  function badge(directory: string) {
    const a = alerts[directory]
    if (!a) return undefined
    if (a.totalSessions === 0) return undefined

    const kind: AlertKind = a.permissions > 0 ? "permission" : a.questions > 0 ? "question" : "busy"
    return { kind, count: a.totalSessions }
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
