import { createContext, useContext, createSignal, createMemo, onCleanup, onMount, type ParentProps } from "solid-js"
import { createStore, produce } from "solid-js/store"
import type { PermissionRequest } from "../sdk/client"
import { useSDK } from "./sdk"
import { useEvents } from "./events"
import { useSync } from "./sync"
import { buildChildMap, sessionDescendantIds } from "../utils/session-tree-request"

interface PermissionContextValue {
  pending: () => PermissionRequest[]
  pendingForSession: (sessionID: string) => PermissionRequest[]
  respond: (id: string, response: "once" | "always" | "reject") => void
  autoAcceptEnabled: () => boolean
  toggleAutoAccept: () => void
  enableAutoAccept: () => void
  disableAutoAccept: () => void
}

const PermissionContext = createContext<PermissionContextValue>()

// Permission types that should be auto-accepted when auto-accept is enabled
function shouldAutoAccept(perm: PermissionRequest): boolean {
  // Auto-accept edit and write permissions (file operations)
  return perm.permission === "edit" || perm.permission === "write"
}

// Cap for responded Set to prevent unbounded memory growth
const RESPONDED_CAP = 1000

export function PermissionProvider(props: ParentProps) {
  const { client, directory } = useSDK()
  const events = useEvents()
  const sync = useSync()

  // Track pending permission requests
  const [permissions, setPermissions] = createStore<Record<string, PermissionRequest>>({})

  // Track auto-accept state (persisted in localStorage, loaded in onMount)
  const storageKey = `prokube-permission-autoaccept-${directory || "global"}`
  const [autoAccept, setAutoAccept] = createSignal(false)

  // Track which permissions we've already responded to (avoid duplicates)
  const responded = new Set<string>()

  // Load auto-accept state from localStorage safely
  onMount(() => {
    try {
      setAutoAccept(localStorage.getItem(storageKey) === "true")
    } catch {
      // localStorage unavailable (SSR, privacy mode, etc.) - default to false
    }
  })

  function pruneResponded() {
    if (responded.size <= RESPONDED_CAP) return
    // Remove oldest entries (first half) when cap exceeded
    const entries = Array.from(responded)
    const toRemove = entries.slice(0, Math.floor(RESPONDED_CAP / 2))
    for (const id of toRemove) {
      responded.delete(id)
    }
  }

  function respond(id: string, response: "once" | "always" | "reject", perm?: PermissionRequest) {
    // Use provided perm or look up from store
    const permission = perm ?? permissions[id]
    if (!permission) return
    if (responded.has(id)) return

    responded.add(id)
    pruneResponded()

    client.permission
      .respond({
        sessionID: permission.sessionID,
        permissionID: id,
        response,
        directory,
      })
      .then(() => {
        // Remove from pending after successful response
        setPermissions(
          produce((draft: Record<string, PermissionRequest>) => {
            delete draft[id]
          }),
        )
      })
      .catch((error: unknown) => {
        console.error("[Permission] Failed to respond:", error)
        responded.delete(id)
      })
  }

  function handlePermissionEvent(perm: PermissionRequest) {
    // If already responded, ignore
    if (responded.has(perm.id)) return

    // If auto-accept is enabled and this permission can be auto-accepted
    if (autoAccept() && shouldAutoAccept(perm)) {
      respond(perm.id, "once", perm)
      return
    }

    // Add to pending
    setPermissions(
      produce((draft: Record<string, PermissionRequest>) => {
        draft[perm.id] = perm
      }),
    )
  }

  // Subscribe to permission events
  const unsub = events.subscribe((event: { type: string; properties: unknown }) => {
    if (event.type === "permission.asked") {
      handlePermissionEvent(event.properties as PermissionRequest)
    }

    if (event.type === "permission.replied") {
      const props = event.properties as { sessionID: string; requestID: string }
      // Remove from pending when replied (by us or another client)
      setPermissions(
        produce((draft: Record<string, PermissionRequest>) => {
          delete draft[props.requestID]
        }),
      )
      responded.add(props.requestID)
    }
  })

  onCleanup(unsub)

  // Load existing pending permissions on mount
  client.permission.list({ directory }).then((res: { data?: PermissionRequest[] }) => {
    const perms = res.data
    if (!perms) return

    for (const perm of perms) {
      if (!perm?.id) continue
      if (responded.has(perm.id)) continue

      // Auto-accept if enabled
      if (autoAccept() && shouldAutoAccept(perm)) {
        respond(perm.id, "once", perm)
        continue
      }

      setPermissions(
        produce((draft: Record<string, PermissionRequest>) => {
          draft[perm.id] = perm
        }),
      )
    }
  })

  const pending = createMemo(() => Object.values(permissions))

  // Group pending permissions by sessionID for O(1) lookup per session.
  const pendingBySession = createMemo(() => {
    const map = new Map<string, PermissionRequest[]>()
    for (const perm of pending()) {
      const list = map.get(perm.sessionID)
      if (list) list.push(perm)
      if (!list) map.set(perm.sessionID, [perm])
    }
    return map
  })

  // Memoize child map once per session-list change so pendingForSession
  // doesn't rebuild it on every call (called per-row in sidebar).
  const children = createMemo(() => buildChildMap(sync.sessions()))

  // Walk the session tree to include permissions from descendant sessions.
  // Returns all permissions for the given session and its children/grandchildren.
  // Uses precomputed pendingBySession map so cost is O(descendants) not O(all permissions).
  function pendingForSession(sessionID: string) {
    const ids = sessionDescendantIds(sync.sessions(), sessionID, children())
    const bySession = pendingBySession()
    const result: PermissionRequest[] = []
    for (const id of ids) {
      const perms = bySession.get(id)
      if (perms) result.push(...perms)
    }
    return result
  }

  function toggleAutoAccept() {
    const next = !autoAccept()
    setAutoAccept(next)
    try {
      localStorage.setItem(storageKey, String(next))
    } catch {
      // localStorage unavailable - state still works in memory
    }

    // If enabling, auto-accept all pending edit permissions
    if (next) {
      for (const perm of Object.values(permissions) as PermissionRequest[]) {
        if (shouldAutoAccept(perm)) {
          respond(perm.id, "once")
        }
      }
    }
  }

  function enableAutoAccept() {
    if (autoAccept()) return
    toggleAutoAccept()
  }

  function disableAutoAccept() {
    if (!autoAccept()) return
    toggleAutoAccept()
  }

  return (
    <PermissionContext.Provider
      value={{
        pending,
        pendingForSession,
        respond,
        autoAcceptEnabled: autoAccept,
        toggleAutoAccept,
        enableAutoAccept,
        disableAutoAccept,
      }}
    >
      {props.children}
    </PermissionContext.Provider>
  )
}

export function usePermission() {
  const ctx = useContext(PermissionContext)
  if (!ctx) throw new Error("usePermission must be used within PermissionProvider")
  return ctx
}
