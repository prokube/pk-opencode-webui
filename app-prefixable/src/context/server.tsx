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

function isValidServerEntry(s: unknown): s is ServerConfig {
  if (!s || typeof s !== "object") return false
  const obj = s as Record<string, unknown>
  if (typeof obj.id !== "string" || !obj.id) return false
  if (typeof obj.name !== "string" || !obj.name) return false
  if (typeof obj.url !== "string" || !obj.url) return false
  // Validate auth shape; default missing/invalid auth to {type:"none"}
  if (obj.auth && typeof obj.auth === "object") {
    const auth = obj.auth as Record<string, unknown>
    if (auth.type === "api-key" && typeof auth.key === "string") return true
    if (auth.type === "basic" && typeof auth.username === "string" && typeof auth.password === "string") return true
    if (auth.type === "none") return true
    // Invalid auth shape — will be defaulted below
  }
  return true
}

function normalizeAuth(s: Record<string, unknown>): ServerAuth {
  const auth = s.auth as Record<string, unknown> | undefined
  if (!auth || typeof auth !== "object") return { type: "none" }
  if (auth.type === "api-key" && typeof auth.key === "string") return auth as ServerAuth
  if (auth.type === "basic" && typeof auth.username === "string" && typeof auth.password === "string") return auth as ServerAuth
  if (auth.type === "none") return { type: "none" }
  return { type: "none" }
}

function loadServers(): ServerConfig[] {
  try {
    const stored = localStorage.getItem(SERVERS_KEY)
    if (stored) {
      const raw = JSON.parse(stored)
      if (Array.isArray(raw) && raw.length > 0) {
        // Validate and normalize entries
        const parsed: ServerConfig[] = raw
          .filter(isValidServerEntry)
          .map((s) => ({ ...s, auth: normalizeAuth(s as unknown as Record<string, unknown>) }))

        // Ensure the default server exists and has the correct URL
        const defaultServer = createDefaultServer()
        const hasDefault = parsed.some((s) => s.id === "local")
        if (!hasDefault) {
          parsed.unshift(defaultServer)
        } else {
          // Update the default server properties in case they changed (URL, env-based auth)
          const idx = parsed.findIndex((s) => s.id === "local")
          if (idx >= 0) {
            parsed[idx] = {
              ...parsed[idx],
              url: defaultServer.url,
              auth: defaultServer.auth,
              name: defaultServer.name,
              isDefault: defaultServer.isDefault,
            }
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
  /** Key that changes whenever the active server's identity or config changes — use for remounting */
  activeServerKey: Accessor<string>
  addServer: (server: Omit<ServerConfig, "id">) => ServerConfig
  updateServer: (id: string, updates: Partial<Omit<ServerConfig, "id">>) => void
  removeServer: (id: string) => void
  setActiveServer: (id: string) => void
}

const ServerContext = createContext<ServerContextValue>()

export function ServerProvider(props: ParentProps) {
  const initialServers = loadServers()
  const initialActiveId = loadActiveServerId()
  // Validate activeId against server list
  const validatedActiveId = initialServers.some((s) => s.id === initialActiveId) ? initialActiveId : "local"
  if (validatedActiveId !== initialActiveId) {
    try { localStorage.setItem(ACTIVE_SERVER_KEY, validatedActiveId) } catch {}
  }

  const [servers, setServers] = createSignal<ServerConfig[]>(initialServers)
  const [activeId, setActiveId] = createSignal(validatedActiveId)
  const [revision, setRevision] = createSignal(0)

  function save(list: ServerConfig[]) {
    // Only bump revision if the active server's config actually changed
    const currentActive = activeServer()
    const nextActive = list.find((s) => s.id === activeId()) || list[0]
    if (nextActive && (nextActive.url !== currentActive.url || JSON.stringify(nextActive.auth) !== JSON.stringify(currentActive.auth))) {
      setRevision((r) => r + 1)
    }
    setServers(list)
    try {
      // Strip env-derived auth from the default "local" server before persisting
      // so credentials from environment variables are not leaked to localStorage.
      const defaultAuth = createDefaultServer().auth
      const toStore = list.map((s) => {
        if (s.id === "local" && JSON.stringify(s.auth) === JSON.stringify(defaultAuth)) {
          return { ...s, auth: { type: "none" as const } }
        }
        return s
      })
      localStorage.setItem(SERVERS_KEY, JSON.stringify(toStore))
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

  function activeServerKey() {
    const s = activeServer()
    return `${s.id}|${s.url}|${s.auth.type}|${revision()}`
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
        activeServerKey,
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
