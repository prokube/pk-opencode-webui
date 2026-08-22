import { createContext, useContext, createSignal, createMemo, createEffect, onCleanup, onMount, type ParentProps } from "solid-js"
import type { PermissionRequest } from "../sdk/client"
import { useSDK } from "./sdk"
import { useSync } from "./sync"
import { LOCAL_SERVER_ID } from "./server"
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

export function resetFailedPermissionResponse(
  permission: PermissionRequest,
  responded: Set<string>,
  autoAttempted: Set<string>,
  pending: () => boolean,
  restore: (permission: PermissionRequest) => void,
) {
  responded.delete(permission.id)
  autoAttempted.delete(permission.id)
  if (!pending()) restore(permission)
}

export function PermissionProvider(props: ParentProps) {
  const { client, directory } = useSDK()
  const sync = useSync()

  // Track auto-accept state (persisted in localStorage, loaded in onMount)
  const serverId = LOCAL_SERVER_ID
  const storageKey = workspaceStorageKey(serverId, directory ?? "", "permissionAutoAccept")
  const [autoAccept, setAutoAccept] = createSignal(false)

  // Track which permissions we've already responded to (avoid duplicates)
  const responded = new Set<string>()
  const autoAttempted = new Set<string>()
  const autoFailed = new Set<string>()
  const confirmed = new Set<string>()

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

  function prune(set: Set<string>) {
    if (set.size <= RESPONDED_CAP) return
    // Remove oldest entries (first half) when cap exceeded
    const entries = Array.from(set)
    const toRemove = entries.slice(0, Math.floor(RESPONDED_CAP / 2))
    for (const id of toRemove) set.delete(id)
  }

  const unsub = sync.subscribe((event) => {
    if (event.type !== "permission.replied") return
    confirmed.add(event.properties.requestID)
    prune(confirmed)
  })
  onCleanup(unsub)

  function respond(id: string, response: "once" | "always" | "reject", perm?: PermissionRequest, auto = false) {
    const permission = perm ?? sync.pendingPermissions[id]
    if (!permission) return
    if (responded.has(id)) return
    if (!auto) autoFailed.delete(id)

    responded.add(id)
    prune(responded)
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
        if (auto) {
          autoFailed.add(id)
          prune(autoFailed)
        }
        resetFailedPermissionResponse(
          permission,
          responded,
          autoAttempted,
          () => confirmed.has(id) || !!sync.pendingPermissions[id],
          sync.setPermission,
        )
      })
  }

  createEffect(() => {
    if (!autoAccept()) return
    for (const permission of Object.values(sync.pendingPermissions)) {
      if (
        !shouldAutoAccept(permission) ||
        responded.has(permission.id) ||
        autoAttempted.has(permission.id) ||
        autoFailed.has(permission.id)
      ) continue
      autoAttempted.add(permission.id)
      prune(autoAttempted)
      respond(permission.id, "once", permission, true)
    }
  })

  const pending = createMemo(() => Object.values(sync.pendingPermissions))

  // Propagate only active permissions through their ancestor chain. This avoids
  // materializing every descendant set for large session trees.
  const pendingBySession = createMemo(() => {
    const map = new Map<string, PermissionRequest[]>()
    const parent = new Map(sync.sessions().map((session) => [session.id, session.parentID]))
    for (const perm of pending()) {
      const seen = new Set<string>()
      for (let id: string | undefined = perm.sessionID; id && !seen.has(id); id = parent.get(id)) {
        seen.add(id)
        const list = map.get(id)
        if (list) list.push(perm)
        if (!list) map.set(id, [perm])
      }
    }
    return map
  })

  function pendingForSession(sessionID: string) {
    return pendingBySession().get(sessionID) ?? []
  }

  function toggleAutoAccept() {
    const next = !autoAccept()
    // Re-enabling is an explicit retry; clear failures before the effect runs.
    if (next) autoFailed.clear()
    setAutoAccept(next)
    try {
      localStorage.setItem(storageKey, String(next))
    } catch {
      // localStorage unavailable - state still works in memory
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
