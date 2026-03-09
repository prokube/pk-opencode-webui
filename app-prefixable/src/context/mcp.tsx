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
  /** Remove project-level override (fall back to global) */
  removeProjectOverride: (name: string) => Promise<void>
}

const MCPContext = createContext<MCPContextValue>()

export function MCPProvider(props: ParentProps) {
  const sdk = useSDK()
  const { client, url } = sdk
  const events = useEvents()
  const [servers, setServers] = createStore<Record<string, MCPStatus>>({})
  const [loading, setLoading] = createSignal(true)
  const [projectOverrides, setProjectOverrides] = createSignal<Record<string, McpProjectOverride>>({})

  function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v)
  }

  async function refresh() {
    try {
      const res = await client.mcp.status()
      if (res.data) {
        // Use reconcile to properly handle deleted servers
        // Without reconcile, removed keys would persist in the store
        setServers(reconcile(res.data as Record<string, MCPStatus>))
      }
    } catch (e) {
      console.error("[MCP] Failed to fetch status:", e)
    }
    // Load project-level MCP overrides from project config (only when a directory is active)
    if (sdk.directory) {
      try {
        const configRes = await client.config.get()
        const cfg = configRes?.data as Record<string, unknown> | undefined
        const mcpSection = cfg?.mcp
        if (isPlainObject(mcpSection)) {
          const overrides: Record<string, McpProjectOverride> = {}
          for (const [k, v] of Object.entries(mcpSection)) {
            if (isPlainObject(v) && "enabled" in v && Object.keys(v).length === 1) {
              overrides[k] = { enabled: !!(v as { enabled: boolean }).enabled }
            }
          }
          setProjectOverrides(overrides)
        } else {
          setProjectOverrides({})
        }
      } catch {
        // Project config may not exist - that's fine
        setProjectOverrides({})
      }
    } else {
      setProjectOverrides({})
    }
    setLoading(false)
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

  async function setProjectOverride(name: string, enabled: boolean) {
    try {
      // Read current project config mcp section
      const configRes = await client.config.get()
      const cfg = configRes?.data as Record<string, unknown> | undefined
      const existingMcp = isPlainObject(cfg?.mcp) ? cfg.mcp : {}
      await client.config.update({
        config: {
          mcp: {
            ...existingMcp,
            [name]: { enabled },
          },
        },
      })
      setProjectOverrides((prev) => ({ ...prev, [name]: { enabled } }))
    } catch (e) {
      console.error("[MCP] Failed to set project override:", name, e)
    }
  }

  async function removeProjectOverride(name: string) {
    try {
      // To remove a key we need to write the full config without it
      const configRes = await client.config.get()
      const cfg = configRes?.data as Record<string, unknown> | undefined
      const existingMcp = isPlainObject(cfg?.mcp) ? { ...cfg.mcp } : {}
      delete existingMcp[name]
      // We can't delete via deep merge, so write the full mcp section without this key
      await client.config.update({
        config: {
          mcp: existingMcp,
        },
      })
      setProjectOverrides((prev) => {
        const next = { ...prev }
        delete next[name]
        return next
      })
    } catch (e) {
      console.error("[MCP] Failed to remove project override:", name, e)
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
        removeProjectOverride,
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
