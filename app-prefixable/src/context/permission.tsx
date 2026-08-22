import { createContext, useContext, createSignal, createMemo, createEffect, onMount, type ParentProps } from "solid-js"
import type { PermissionRequest } from "../sdk/client"
import { useSDK } from "./sdk"
import { useSync } from "./sync"
import { buildChildMap, sessionDescendantIds } from "../utils/session-tree-request"
import { useServer } from "./server"
import { legacyStorageValue, workspaceStorageKey } from "../utils/storage"

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
  const server = useServer()
  const sync = useSync()

  // Track auto-accept state (persisted in localStorage, loaded in onMount)
  const serverId = server.activeServerId()
  const storageKey = workspaceStorageKey(serverId, directory ?? "", "permissionAutoAccept")
  const [autoAccept, setAutoAccept] = createSignal(false)

  // Track which permissions we've already responded to (avoid duplicates)
  const responded = new Set<string>()
  const autoAttempted = new Set<string>()

  // Load auto-accept state from localStorage safely
  onMount(() => {
    try {
      const current = localStorage.getItem(storageKey)
      const legacy = serverId === "local"
        ? [localStorage.getItem(`prokube-permission-autoaccept-${directory || "global"}`)]
        : []
      const result = legacyStorageValue(serverId, current, legacy, (value) => value === "true" || value === "false")
      if (result.migrated && result.value) localStorage.setItem(storageKey, result.value)
      setAutoAccept(result.value === "true")
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
    const permission = perm ?? sync.pendingPermissions[id]
    if (!permission) return
    if (responded.has(id)) return

    responded.add(id)
    pruneResponded()
    sync.dismissPermission(id)

    client.permission
      .respond({
        sessionID: permission.sessionID,
        permissionID: id,
        response,
        directory,
      })
      .catch((error: unknown) => {
        console.error("[Permission] Failed to respond:", error)
        responded.delete(id)
        if (!sync.pendingPermissions[id]) sync.setPermission(permission)
      })
  }

  createEffect(() => {
    if (!autoAccept()) return
    for (const permission of Object.values(sync.pendingPermissions)) {
      if (!shouldAutoAccept(permission) || responded.has(permission.id) || autoAttempted.has(permission.id)) continue
      autoAttempted.add(permission.id)
      respond(permission.id, "once", permission)
    }
  })

  const pending = createMemo(() => Object.values(sync.pendingPermissions))

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

  // Memoize child map once per session-list change so descendant lookups
  // don't rebuild it on every call (called per-row in sidebar).
  const children = createMemo(() => buildChildMap(sync.sessions()))

  // Cache descendant ID sets per session to avoid BFS walks on every render.
  // Recomputed when the session list changes (child map changes).
  const descendantsCache = createMemo(() => {
    const map = new Map<string, Set<string>>()
    const cm = children()
    for (const s of sync.sessions()) {
      map.set(s.id, sessionDescendantIds(sync.sessions(), s.id, cm))
    }
    return map
  })

  // Walk the session tree to include permissions from descendant sessions.
  // Returns all permissions for the given session and its children/grandchildren.
  // Uses precomputed descendant sets + pendingBySession map for O(descendants) per call.
  function pendingForSession(sessionID: string) {
    const ids = descendantsCache().get(sessionID) ?? sessionDescendantIds(sync.sessions(), sessionID, children())
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
      for (const perm of Object.values(sync.pendingPermissions)) {
        if (shouldAutoAccept(perm)) {
          autoAttempted.add(perm.id)
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

export function useOptionalPermission() {
  return useContext(PermissionContext)
}
