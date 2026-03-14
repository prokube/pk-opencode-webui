import { createContext, useContext, createSignal, createEffect, onCleanup, type ParentProps, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { useBasePath } from "./base-path"

const STORAGE_KEY = "opencode-servers"
const HEALTH_POLL_INTERVAL = 10_000

export interface ServerConnection {
  url: string
  name?: string
  username?: string
  password?: string
}

export type ServerHealth = "healthy" | "unhealthy" | "checking"

interface ServerState {
  servers: ServerConnection[]
  activeKey: string | null // null = local server
  health: Record<string, ServerHealth>
}

interface ServerContextValue {
  /** List of configured external servers */
  servers: Accessor<ServerConnection[]>
  /** Currently active server key (URL) or null for local */
  activeKey: Accessor<string | null>
  /** Get the effective server URL for API calls (always local, proxy handles external) */
  serverUrl: Accessor<string>
  /** Get the active external server (or null if using local) */
  activeServer: Accessor<ServerConnection | null>
  /** Health status for each server */
  health: (key: string) => ServerHealth
  /** Whether using an external server */
  isExternal: Accessor<boolean>
  /** Add a new server */
  add: (server: ServerConnection) => void
  /** Remove a server by URL */
  remove: (url: string) => void
  /** Update a server */
  update: (url: string, server: ServerConnection) => void
  /** Set active server (null for local) */
  setActive: (key: string | null) => void
  /** Check health of a server */
  checkHealth: (url: string, username?: string, password?: string) => Promise<boolean>
  /** Create a fetch function that routes through proxy if external server is active */
  createProxyFetch: () => (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
}

const ServerContext = createContext<ServerContextValue>()

export function normalizeServerUrl(input: string): string | undefined {
  const trimmed = input.trim()
  if (!trimmed) return undefined
  const withProtocol = /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`
  return withProtocol.replace(/\/+$/, "")
}

export function serverDisplayName(server: ServerConnection): string {
  if (server.name) return server.name
  return server.url.replace(/^https?:\/\//, "").replace(/\/+$/, "")
}

function loadFromStorage(): Partial<ServerState> {
  if (typeof window === "undefined") return {}
  const stored = localStorage.getItem(STORAGE_KEY)
  if (!stored) return {}
  try {
    return JSON.parse(stored)
  } catch {
    return {}
  }
}

function saveToStorage(state: ServerState) {
  if (typeof window === "undefined") return
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    servers: state.servers,
    activeKey: state.activeKey,
  }))
}

export function ServerProvider(props: ParentProps) {
  const basePath = useBasePath()
  const stored = loadFromStorage()

  const [state, setState] = createStore<ServerState>({
    servers: stored.servers || [],
    activeKey: stored.activeKey ?? null,
    health: {},
  })

  // Persist changes
  createEffect(() => {
    saveToStorage(state)
  })

  // Compute effective server URL (always local - proxy handles external routing)
  const serverUrl = () => basePath.serverUrl

  // Get active external server
  const activeServer = (): ServerConnection | null => {
    if (!state.activeKey) return null
    return state.servers.find(s => s.url === state.activeKey) || null
  }

  // Create a fetch function that routes through proxy for external servers
  const createProxyFetch = () => {
    const proxyFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const server = activeServer()
      
      // If no external server active, use normal fetch
      if (!server) {
        return fetch(input, init)
      }

      // Rewrite URL to go through proxy
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      const urlObj = new URL(url, basePath.serverUrl)
      
      // Replace the path with proxy path
      const originalPath = urlObj.pathname
      const proxyUrl = `${basePath.serverUrl}/api/external/proxy${originalPath}${urlObj.search}`

      // Add proxy headers
      const headers = new Headers(init?.headers)
      headers.set("X-Target-Server", server.url)
      if (server.username && server.password) {
        headers.set("X-Target-Auth", `Basic ${btoa(`${server.username}:${server.password}`)}`)
      }

      return fetch(proxyUrl, {
        ...init,
        headers,
      })
    }
    return proxyFetch
  }

  const checkHealth = async (url: string, username?: string, password?: string): Promise<boolean> => {
    setState("health", url, "checking")
    try {
      const headers: Record<string, string> = {}
      if (username && password) {
        headers["Authorization"] = `Basic ${btoa(`${username}:${password}`)}`
      }
      
      // Use proxy endpoint to check external server health
      const proxyUrl = `${basePath.serverUrl}/api/external/health`
      const response = await fetch(proxyUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, username, password }),
      })
      
      const healthy = response.ok
      setState("health", url, healthy ? "healthy" : "unhealthy")
      return healthy
    } catch {
      setState("health", url, "unhealthy")
      return false
    }
  }

  // Poll health for all servers
  createEffect(() => {
    const servers = state.servers
    if (servers.length === 0) return

    const checkAll = () => {
      for (const server of servers) {
        checkHealth(server.url, server.username, server.password)
      }
    }

    checkAll()
    const interval = setInterval(checkAll, HEALTH_POLL_INTERVAL)
    onCleanup(() => clearInterval(interval))
  })

  const add = (server: ServerConnection) => {
    const normalized = normalizeServerUrl(server.url)
    if (!normalized) return
    
    const existing = state.servers.findIndex(s => s.url === normalized)
    if (existing !== -1) {
      // Update existing
      setState("servers", existing, { ...server, url: normalized })
    } else {
      setState("servers", state.servers.length, { ...server, url: normalized })
    }
    setState("activeKey", normalized)
  }

  const remove = (url: string) => {
    setState("servers", state.servers.filter(s => s.url !== url))
    if (state.activeKey === url) {
      setState("activeKey", null)
    }
  }

  const update = (url: string, server: ServerConnection) => {
    const normalized = normalizeServerUrl(server.url)
    if (!normalized) return

    const index = state.servers.findIndex(s => s.url === url)
    if (index === -1) return

    if (url !== normalized) {
      // URL changed - remove old, add new
      remove(url)
      add({ ...server, url: normalized })
    } else {
      setState("servers", index, { ...server, url: normalized })
    }
  }

  const setActive = (key: string | null) => {
    setState("activeKey", key)
  }

  const value: ServerContextValue = {
    servers: () => state.servers,
    activeKey: () => state.activeKey,
    serverUrl,
    activeServer,
    health: (key: string) => state.health[key] || "checking",
    isExternal: () => state.activeKey !== null,
    add,
    remove,
    update,
    setActive,
    checkHealth,
    createProxyFetch,
  }

  return (
    <ServerContext.Provider value={value}>
      {props.children}
    </ServerContext.Provider>
  )
}

export function useServer() {
  const ctx = useContext(ServerContext)
  if (!ctx) throw new Error("useServer must be used within ServerProvider")
  return ctx
}
