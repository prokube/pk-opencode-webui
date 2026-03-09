import { createContext, useContext, createSignal, onMount, type ParentProps, createMemo } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useSDK } from "./sdk"
import { useEvents } from "./events"

// MCP Status types matching the backend
type MCPStatus =
  | { status: "connected" }
  | { status: "disabled" }
  | { status: "failed"; error: string }
  | { status: "needs_auth" }
  | { status: "needs_client_registration"; error: string }

// MCP Config types - exported for use in components
export interface McpLocalConfig {
  type: "local"
  command: string[]
  environment?: Record<string, string>
  enabled?: boolean
  timeout?: number
}

export interface McpOAuthConfig {
  clientId?: string
  clientSecret?: string
  scope?: string
}

export interface McpRemoteConfig {
  type: "remote"
  url: string
  headers?: Record<string, string>
  oauth?: McpOAuthConfig | false
  enabled?: boolean
  timeout?: number
}

export type McpConfig = McpLocalConfig | McpRemoteConfig

// Per-project MCP override: just { enabled: boolean }
export interface McpProjectOverride {
  enabled: boolean
}

interface MCPContextValue {
  servers: Record<string, MCPStatus>
  loading: () => boolean
  refresh: () => Promise<void>
  connect: (name: string) => Promise<void>
  disconnect: (name: string) => Promise<void>
  add: (name: string, config: McpConfig) => Promise<void>
  remove: (name: string) => Promise<void>
  startAuth: (name: string) => Promise<{ authorizationUrl: string } | null>
  stats: () => { enabled: number; failed: boolean; total: number }
  /** Per-project MCP overrides (read from project config) */
  projectOverrides: () => Record<string, McpProjectOverride>
  /** Set project-level enable/disable for an MCP server */
  setProjectOverride: (name: string, enabled: boolean) => Promise<void>
  /** Reset project-level override back to enabled (effectively removing the override) */
  resetProjectOverride: (name: string) => Promise<void>
  /** Check if a specific server override is currently being updated */
  isOverrideLoading: (name: string) => boolean
}

const MCPContext = createContext<MCPContextValue>()

export function MCPProvider(props: ParentProps) {
  const sdk = useSDK()
  const { client, url } = sdk
  const events = useEvents()
  const [servers, setServers] = createStore<Record<string, MCPStatus>>({})
  const [loading, setLoading] = createSignal(true)
  const [projectOverrides, setProjectOverrides] = createSignal<Record<string, McpProjectOverride>>({})
  const [overrideLoadingSet, setOverrideLoadingSet] = createSignal<Set<string>>(new Set())
  let refreshSeq = 0

  function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v)
  }

  /** Parse project config MCP section into override records.
   *  Only entries with a boolean `enabled` field (and no `type` field, which
   *  would indicate a full server config rather than an override) are treated
   *  as overrides. { enabled: true } is the default state and is ignored. */
  function parseOverrides(cfg: Record<string, unknown> | undefined): Record<string, McpProjectOverride> {
    const mcpSection = cfg?.mcp
    if (!isPlainObject(mcpSection)) return {}
    const overrides: Record<string, McpProjectOverride> = {}
    for (const [k, v] of Object.entries(mcpSection)) {
      if (!isPlainObject(v)) continue
      // Skip full server configs (they have a `type` field like "local" or "remote")
      if ("type" in v) continue
      if (!("enabled" in v)) continue
      const raw = (v as { enabled: unknown }).enabled
      // Only accept boolean values; ignore non-boolean (e.g. string "false")
      if (typeof raw !== "boolean") continue
      // Only track explicit disables as overrides; enabled:true = default
      if (!raw) overrides[k] = { enabled: false }
    }
    return overrides
  }

  async function refresh() {
    const seq = ++refreshSeq
    setLoading(true)

    try {
      // Fetch MCP status and project overrides in parallel
      const statusPromise = client.mcp.status().catch((e) => {
        console.error("[MCP] Failed to fetch status:", e)
        return null
      })
      const overridesPromise = sdk.directory
        ? client.config.get().catch(() => null)
        : Promise.resolve(null)

      const [statusRes, configRes] = await Promise.all([statusPromise, overridesPromise])

      // Discard stale results if a newer refresh was started
      if (seq !== refreshSeq) return

      if (statusRes?.data) {
        setServers(reconcile(statusRes.data as Record<string, MCPStatus>))
      }
      // Only update overrides when we got a valid response; keep previous
      // state on transient failures to avoid flipping toggles
      if (!sdk.directory) {
        setProjectOverrides({})
      } else if (configRes?.data) {
        setProjectOverrides(parseOverrides(configRes.data as Record<string, unknown>))
      }
    } finally {
      // Only update loading if this is still the latest refresh
      if (seq === refreshSeq) setLoading(false)
    }
  }

  async function connect(name: string) {
    try {
      await client.mcp.connect({ name })
      await refresh()
    } catch (e) {
      console.error("[MCP] Failed to connect:", name, e)
    }
  }

  async function disconnect(name: string) {
    try {
      await client.mcp.disconnect({ name })
      await refresh()
    } catch (e) {
      console.error("[MCP] Failed to disconnect:", name, e)
    }
  }

  async function add(name: string, mcpConfig: McpConfig) {
    try {
      console.log("[MCP] Adding server:", name, mcpConfig)

      // First, persist the MCP config to the global config file
      // This is necessary because mcp.status() reads from the config file
      const currentConfig = await client.global.config.get()
      const existingMcp = (currentConfig.data?.mcp as Record<string, McpConfig> | undefined) || {}
      await client.global.config.update({
        config: {
          mcp: {
            ...existingMcp,
            [name]: mcpConfig,
          },
        },
      })
      console.log("[MCP] Config persisted to global config")

      // Now call mcp.add to connect the server
      const response = await client.mcp.add({ name, config: mcpConfig })
      console.log("[MCP] Add server response:", response)
      await refresh()

      // Check if the server actually connected successfully
      const s = await client.mcp.status()
      const status = s.data?.[name]
      console.log("[MCP] Server status after add:", status)

      if (status?.status === "failed") {
        throw new Error(`Failed to connect: ${status.error}`)
      }
      if (status?.status === "needs_auth") {
        throw new Error("Server requires OAuth authentication. Please configure OAuth settings.")
      }
      if (status?.status === "needs_client_registration") {
        throw new Error(status.error || "Server requires OAuth client registration")
      }
    } catch (e) {
      console.error("[MCP] Failed to add server:", name, e)
      throw e
    }
  }

  async function remove(name: string) {
    try {
      console.log("[MCP] Removing server:", name)

      // First disconnect if connected
      await client.mcp.disconnect({ name }).catch(() => {
        // Ignore disconnect errors - server might not be connected
      })

      // Remove from global config using extended API endpoint
      // (We can't use the SDK because the backend does a deep merge and doesn't support deletion)
      const response = await fetch(`${url}/api/ext/mcp/${encodeURIComponent(name)}`, {
        method: "DELETE",
      })

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: response.statusText }))
        throw new Error(error.error || "Failed to delete MCP server")
      }

      console.log("[MCP] Server removed from global config")

      // Trigger a backend restart by updating config (this causes server.instance.disposed)
      // The backend will reload the config file which now has the server removed
      await client.global.config.update({ config: {} })
      console.log("[MCP] Triggered backend restart")

      // Wait for backend to restart and refresh
      // The server.connected event should also trigger a refresh, but we do it here too for reliability
      await new Promise((resolve) => setTimeout(resolve, 1500))
      await refresh()
      console.log("[MCP] Refreshed after restart")
    } catch (e) {
      console.error("[MCP] Failed to remove server:", name, e)
      throw e
    }
  }

  function addLoading(name: string) {
    setOverrideLoadingSet((prev) => new Set([...prev, name]))
  }
  function removeLoading(name: string) {
    setOverrideLoadingSet((prev) => {
      const next = new Set(prev)
      next.delete(name)
      return next
    })
  }

  async function setProjectOverride(name: string, enabled: boolean) {
    if (!sdk.directory) {
      console.warn("[MCP] Cannot set project override without an active directory")
      return
    }
    addLoading(name)
    try {
      // Deep merge is sufficient — just patch the mcp section with the override.
      // If the project config doesn't exist yet, the backend creates it.
      await client.config.update({
        config: {
          mcp: { [name]: { enabled } },
        },
      })
      if (enabled) {
        // enabled:true = default, remove from overrides
        setProjectOverrides((prev) => {
          const next = { ...prev }
          delete next[name]
          return next
        })
      } else {
        setProjectOverrides((prev) => ({ ...prev, [name]: { enabled } }))
      }
      // Refresh to sync MCP status with the updated config
      await refresh()
    } catch (e) {
      console.error("[MCP] Failed to set project override:", name, e)
    } finally {
      removeLoading(name)
    }
  }

  /** Reset a project override back to enabled. Since the backend config API uses
   *  deep-merge and cannot delete keys, we write { enabled: true } to neutralize
   *  a prior disable. parseOverrides() ignores enabled:true entries so the UI
   *  treats this as no-override. The residual key in opencode.json is harmless. */
  async function resetProjectOverride(name: string) {
    if (!sdk.directory) {
      console.warn("[MCP] Cannot reset project override without an active directory")
      return
    }
    addLoading(name)
    try {
      await client.config.update({
        config: {
          mcp: { [name]: { enabled: true } },
        },
      })
      // Remove from local state — enabled:true is the default / no-override state
      setProjectOverrides((prev) => {
        const next = { ...prev }
        delete next[name]
        return next
      })
      // Refresh to sync MCP status with the updated config
      await refresh()
    } catch (e) {
      console.error("[MCP] Failed to reset project override:", name, e)
    } finally {
      removeLoading(name)
    }
  }

  async function startAuth(name: string): Promise<{ authorizationUrl: string } | null> {
    try {
      const res = await client.mcp.auth.start({ name })
      return res.data as { authorizationUrl: string } | null
    } catch (e) {
      console.error("[MCP] Failed to start auth:", name, e)
      return null
    }
  }

  const stats = createMemo(() => {
    const entries = Object.entries(servers)
    const enabled = entries.filter(([, s]) => s.status === "connected").length
    const failed = entries.some(([, s]) => s.status === "failed")
    const total = entries.length
    return { enabled, failed, total }
  })

  onMount(() => {
    refresh()

    // Listen for MCP-related events and server restarts
    const unsub = events.subscribe((event) => {
      // Refresh on any mcp-related event type
      if (event.type.startsWith("mcp.")) {
        refresh()
      }
      // Also refresh when server reconnects (after config change causes restart)
      // Small delay to ensure backend has fully initialized
      if (event.type === "server.connected") {
        setTimeout(() => refresh(), 500)
      }
    })

    return unsub
  })

  return (
    <MCPContext.Provider
      value={{
        servers,
        loading,
        refresh,
        connect,
        disconnect,
        add,
        remove,
        startAuth,
        stats,
        projectOverrides,
        setProjectOverride,
        resetProjectOverride,
        isOverrideLoading: (name: string) => overrideLoadingSet().has(name),
      }}
    >
      {props.children}
    </MCPContext.Provider>
  )
}

export function useMCP() {
  const ctx = useContext(MCPContext)
  if (!ctx) throw new Error("useMCP must be used within MCPProvider")
  return ctx
}
