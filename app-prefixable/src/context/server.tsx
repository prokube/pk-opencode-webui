import { createContext, useContext, createSignal, type ParentProps, type Accessor } from "solid-js"
import { type ServerConfig, type ServerAuth, getAuthHeaders } from "../types/server"
import { getServerUrl } from "../utils/path"

const SERVERS_KEY = "opencode.servers"
const ACTIVE_SERVER_KEY = "opencode.activeServerId"

function createDefaultServer(): ServerConfig {
  // Check for env-var pre-configured auth
  const apiKey = import.meta.env.VITE_OPENCODE_API_KEY as string | undefined
  const username = import.meta.env.VITE_OPENCODE_SERVER_USERNAME as string | undefined
  const password = import.meta.env.VITE_OPENCODE_SERVER_PASSWORD as string | undefined

  let auth: ServerAuth = { type: "none" }
  if (apiKey) {
    auth = { type: "api-key", key: apiKey }
  } else if (username && password) {
    auth = { type: "basic", username, password }
  }

  return {
    id: "local",
    name: "Local Server",
    url: getServerUrl(),
    auth,
    isDefault: true,
  }
}

function loadServers(): ServerConfig[] {
  try {
    const stored = localStorage.getItem(SERVERS_KEY)
    if (stored) {
      const parsed = JSON.parse(stored) as ServerConfig[]
      if (Array.isArray(parsed) && parsed.length > 0) {
        // Ensure the default server exists and has the correct URL
        const defaultServer = createDefaultServer()
        const hasDefault = parsed.some((s) => s.id === "local")
        if (!hasDefault) {
          parsed.unshift(defaultServer)
        } else {
          // Update the default server URL in case it changed
          const idx = parsed.findIndex((s) => s.id === "local")
          if (idx >= 0) {
            parsed[idx] = { ...parsed[idx], url: defaultServer.url }
          }
        }
        return parsed
      }
    }
  } catch {}
  return [createDefaultServer()]
}

function loadActiveServerId(): string {
  try {
    return localStorage.getItem(ACTIVE_SERVER_KEY) || "local"
  } catch {
    return "local"
  }
}

interface ServerContextValue {
  servers: Accessor<ServerConfig[]>
  activeServer: Accessor<ServerConfig>
  activeServerId: Accessor<string>
  authHeaders: Accessor<Record<string, string>>
  serverUrl: Accessor<string>
  addServer: (server: Omit<ServerConfig, "id">) => ServerConfig
  updateServer: (id: string, updates: Partial<Omit<ServerConfig, "id">>) => void
  removeServer: (id: string) => void
  setActiveServer: (id: string) => void
}

const ServerContext = createContext<ServerContextValue>()

export function ServerProvider(props: ParentProps) {
  const [servers, setServers] = createSignal<ServerConfig[]>(loadServers())
  const [activeId, setActiveId] = createSignal(loadActiveServerId())

  function save(list: ServerConfig[]) {
    setServers(list)
    try {
      localStorage.setItem(SERVERS_KEY, JSON.stringify(list))
    } catch {}
  }

  function activeServer() {
    return servers().find((s) => s.id === activeId()) || servers()[0]
  }

  function authHeaders() {
    return getAuthHeaders(activeServer().auth)
  }

  function serverUrl() {
    return activeServer().url
  }

  function addServer(server: Omit<ServerConfig, "id">): ServerConfig {
    const newServer: ServerConfig = { ...server, id: crypto.randomUUID() }
    save([...servers(), newServer])
    return newServer
  }

  function updateServer(id: string, updates: Partial<Omit<ServerConfig, "id">>) {
    save(servers().map((s) => (s.id === id ? { ...s, ...updates } : s)))
  }

  function removeServer(id: string) {
    if (id === "local") return // Can't remove default
    save(servers().filter((s) => s.id !== id))
    if (activeId() === id) {
      setActiveId("local")
      try { localStorage.setItem(ACTIVE_SERVER_KEY, "local") } catch {}
    }
  }

  function setActiveServerFn(id: string) {
    setActiveId(id)
    try { localStorage.setItem(ACTIVE_SERVER_KEY, id) } catch {}
  }

  return (
    <ServerContext.Provider
      value={{
        servers,
        activeServer,
        activeServerId: activeId,
        authHeaders,
        serverUrl,
        addServer,
        updateServer,
        removeServer,
        setActiveServer: setActiveServerFn,
      }}
    >
      {props.children}
    </ServerContext.Provider>
  )
}

export function useServer() {
  const ctx = useContext(ServerContext)
  if (!ctx) throw new Error("useServer must be used within ServerProvider")
  return ctx
}
