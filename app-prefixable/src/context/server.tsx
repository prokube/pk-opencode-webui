import {
  batch,
  createContext,
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  onCleanup,
  onMount,
  useContext,
  Show,
  type ParentProps,
} from "solid-js"
import { getServerUrl, base64Encode } from "../utils/path"
import {
  LOCAL_SERVER_ID,
  normalizeServerUrl,
  parseConnections,
  parseTabs,
  connectionUrl,
  needsServerCredential,
  serverAuthHeaders,
  tabKey,
  type ServerConnection,
  type SessionTab,
} from "../utils/servers"
import { createServerEvents } from "./server-events"

export { LOCAL_SERVER_ID } from "../utils/servers"
const CONNECTIONS = "opencode.connections.v1"
const CREDENTIALS = "opencode.connectionCredentials.v1"
const TABS = "opencode.sessionTabs.v1"

function read(storage: "localStorage" | "sessionStorage", key: string) {
  try {
    return window[storage].getItem(key)
  } catch {
    return null
  }
}
function write(storage: "localStorage" | "sessionStorage", key: string, value: unknown) {
  try {
    window[storage].setItem(key, JSON.stringify(value))
  } catch {
    /* In-memory operation still works. */
  }
}
function secrets(): Record<string, string> {
  try {
    const value = JSON.parse(read("sessionStorage", CREDENTIALS) || "{}")
    return value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
        )
      : {}
  } catch {
    return {}
  }
}

function createConnections() {
  onMount(() => {
    try {
      sessionStorage.removeItem("opencode.serversCreds")
      localStorage.removeItem("opencode.servers")
    } catch {
      /* Preserve the existing cleanup of retired connection formats. */
    }
  })
  const local: ServerConnection = { id: LOCAL_SERVER_ID, url: getServerUrl(), name: "Local server", auth: "none" }
  const [connections, setConnections] = createSignal(parseConnections(read("localStorage", CONNECTIONS)))
  const [credentials, setCredentials] = createSignal(secrets())
  const list = createMemo(() => [local, ...connections()])
  const [tabs, setTabs] = createSignal(
    parseTabs(
      read("localStorage", TABS),
      list().map((item) => item.id),
    ),
  )
  const [busy, setBusy] = createSignal<Record<string, boolean>>({})
  const workspaces = new Map<string, string>()
  const removalHandlers = new Set<(id: string) => void>()
  const projectRoutes = new Map<string, string>()
  const composers = new Map<string, { empty: () => boolean; discard: (token: string) => void }>()
  const [leases, setLeases] = createSignal<string[]>([])
  const idle = () => undefined
  const [active, setActive] = createSignal<() => string | undefined>(idle)
  const streams = new Map<
    string,
    { value: ReturnType<typeof createServerEvents>; dispose: () => void; signature: string }
  >()

  const transport = (item: ServerConnection) => ({
    id: item.id,
    name: item.name,
    local: item.id === LOCAL_SERVER_ID,
    session: item.auth === "session",
    relay: item.id !== LOCAL_SERVER_ID && item.auth !== "session",
    serverUrl: () => connectionUrl(local.url, item),
    authHeaders: () => serverAuthHeaders(item, credentials()[item.id]),
  })
  createEffect(() => write("localStorage", CONNECTIONS, connections()))
  createEffect(() => write("sessionStorage", CREDENTIALS, credentials()))
  createEffect(() => write("localStorage", TABS, tabs()))
  onCleanup(() => {
    for (const source of streams.values()) source.dispose()
  })
  const events = (item: ServerConnection) => {
    const signature = JSON.stringify([item.url, item.auth, item.username, credentials()[item.id]])
    const previous = streams.get(item.id)
    if (previous?.signature === signature) return previous.value
    previous?.dispose()
    const source = createRoot((dispose) => {
      const value = createServerEvents(transport(item))
      value.subscribe(({ payload }) => {
        if (payload.type === "session.updated") {
          const session = payload.properties.info
          setTabs((previous) =>
            previous.some(
              (tab) =>
                tab.server === item.id &&
                tab.sessionId === session.id &&
                (tab.title !== session.title || tab.directory !== session.directory),
            )
              ? previous.map((tab) =>
                  tab.server === item.id && tab.sessionId === session.id
                    ? { ...tab, title: session.title, directory: session.directory }
                    : tab,
                )
              : previous,
          )
        }
        if (payload.type === "session.deleted")
          setTabs((previous) =>
            previous.filter((tab) => tab.server !== item.id || tab.sessionId !== payload.properties.info.id),
          )
        if (payload.type !== "session.status" && payload.type !== "session.idle") return
        const key = tabKey({ server: item.id, sessionId: payload.properties.sessionID })
        if (payload.type === "session.idle" || payload.properties.status.type === "idle") {
          setBusy((previous) => Object.fromEntries(Object.entries(previous).filter(([id]) => id !== key)))
          return
        }
        if (tabs().some((tab) => tabKey(tab) === key)) setBusy((previous) => ({ ...previous, [key]: true }))
      })
      return { value, dispose, signature }
    })
    streams.set(item.id, source)
    return source.value
  }
  createEffect(() => {
    const open = new Set(tabs().map((tab) => tab.server))
    for (const id of leases()) open.add(id)
    const current = active()()
    if (current) open.add(current)
    const wanted = list().filter((item) => open.has(item.id) && (!needsServerCredential(item) || credentials()[item.id]))
    const ids = new Set(wanted.map((item) => item.id))
    for (const [id, source] of streams) {
      if (ids.has(id)) continue
      source.dispose()
      streams.delete(id)
    }
    for (const item of wanted) events(item)
    const keys = new Set(tabs().map(tabKey))
    setBusy((previous) =>
      Object.keys(previous).some((key) => !keys.has(key))
        ? Object.fromEntries(Object.entries(previous).filter(([key]) => keys.has(key)))
        : previous,
    )
  })
  return {
    onRemove(handler: (id: string) => void) { removalHandlers.add(handler) },
    composer(server: string, directory: string, empty: () => boolean, discard: (token: string) => void) {
      const key = JSON.stringify([server, directory])
      const composer = { empty, discard }
      composers.set(key, composer)
      return () => { if (composers.get(key) === composer) composers.delete(key) }
    },
    composerEmpty(server: string, directory: string) {
      return composers.get(JSON.stringify([server, directory]))?.empty() === true
    },
    rememberWorkspace(id: string, href: string) { workspaces.set(id, href) },
    rememberProject(id: string, directory: string, href: string) { projectRoutes.set(JSON.stringify([id, directory]), href) },
    projectRoute(id: string, directory: string) { return projectRoutes.get(JSON.stringify([id, directory])) },
    workspace(id: string) { return workspaces.get(id) },
    list,
    tabs,
    busy,
    credentials,
    transport,
    events,
    retain(id: string) {
      setLeases((previous) => [...previous, id])
      return () => setLeases((previous) => {
        const next = [...previous]
        const index = next.indexOf(id)
        if (index !== -1) next.splice(index, 1)
        return next
      })
    },
    followActive(read: () => string | undefined) {
      setActive(() => read)
      return () => {
        if (active() === read) setActive(() => idle)
      }
    },
    save(input: Omit<ServerConnection, "id">, secret: string) {
      const url = normalizeServerUrl(input.url)
      const item = { ...input, url, id: base64Encode(url) }
      connectionUrl(local.url, item)
      if (!connections().some((row) => row.id === item.id) && connections().length >= 20)
        throw new Error("At most 20 server connections can be saved")
      batch(() => {
        setCredentials((previous) => ({ ...Object.fromEntries(Object.entries(previous).filter(([id]) => id !== item.id)), ...(needsServerCredential(item) ? { [item.id]: secret } : {}) }))
        setConnections((previous) => [...previous.filter((row) => row.id !== item.id), item])
      })
      return item
    },
    remove(id: string) {
      streams.get(id)?.dispose()
      streams.delete(id)
      workspaces.delete(id)
      for (const key of projectRoutes.keys()) if (JSON.parse(key)[0] === id) projectRoutes.delete(key)
      batch(() => {
        setConnections((previous) => previous.filter((row) => row.id !== id))
        setCredentials((previous) => Object.fromEntries(Object.entries(previous).filter(([key]) => key !== id)))
        setTabs((previous) => previous.filter((tab) => tab.server !== id))
        setBusy((previous) => Object.fromEntries(Object.entries(previous).filter(([key]) => JSON.parse(key)[0] !== id)))
      })
      for (const handler of removalHandlers) handler(id)
    },
    remember(tab: SessionTab) {
      setTabs((previous) => {
        const current = previous.find((item) => tabKey(item) === tabKey(tab))
        if (current && current.title === tab.title && current.directory === tab.directory) return previous
        return current
          ? previous.map((item) => (tabKey(item) === tabKey(tab) ? { ...tab, sidebarID: item.sidebarID } : item))
          : [...previous, tab].slice(-40)
      })
    },
    promote(server: string, draftID: string, tab: SessionTab) {
      setTabs((previous) => {
        const index = previous.findIndex((item) => item.server === server && item.directory === tab.directory && item.draftID === draftID)
        if (index < 0)
          return previous.some((item) => tabKey(item) === tabKey(tab)) ? previous : [...previous, tab].slice(-40)
        return previous.flatMap((item, position) =>
          position === index ? [{ ...tab, sidebarID: draftID }] : tabKey(item) === tabKey(tab) ? [] : [item],
        )
      })
    },
    close(tab: SessionTab) {
      if (tab.draftID) {
        const key = JSON.stringify([tab.server, tab.directory])
        composers.get(key)?.discard(tab.draftID)
        const href = projectRoutes.get(key)
        if (href && new URL(href, "http://workspace.invalid").searchParams.get("new") === tab.draftID) projectRoutes.delete(key)
      }
      setTabs((previous) => previous.filter((item) => tabKey(item) !== tabKey(tab)))
      setBusy((previous) => Object.fromEntries(Object.entries(previous).filter(([key]) => key !== tabKey(tab))))
    },
  }
}

const ConnectionsContext = createContext<ReturnType<typeof createConnections>>()
export function ServerProvider(props: ParentProps) {
  return <ConnectionsContext.Provider value={createConnections()}>{props.children}</ConnectionsContext.Provider>
}
export function useConnections() {
  const context = useContext(ConnectionsContext)
  if (!context) throw new Error("Missing ServerProvider")
  return context
}

type Connection = ReturnType<ReturnType<typeof createConnections>["transport"]> & {
  events: ReturnType<typeof createServerEvents>
}
const ServerContext = createContext<Connection>()
export function ServerScope(props: ParentProps & { connection: ServerConnection }) {
  const registry = useConnections()
  const value = { ...registry.transport(props.connection), events: registry.events(props.connection) }
  return <ServerContext.Provider value={value}>
    <Show when={!value.session || !value.events.authenticationRequired()} fallback={
      <div class="p-8" role="alert">
        <p>Browser-Session expired or access denied for {props.connection.name}.</p>
        <p>Sign in again and check your access to this server.</p>
        <button type="button" class="mt-3 underline" onClick={() => window.location.reload()}>Reload and sign in</button>
      </div>
    }>{props.children}</Show>
  </ServerContext.Provider>
}
export function useServer() {
  const context = useContext(ServerContext)
  if (!context) throw new Error("Missing server connection scope")
  return context
}
