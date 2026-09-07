import { createContext, useContext, onMount, type ParentProps, type Accessor } from "solid-js"
import { getServerUrl } from "../utils/path"

export const LOCAL_SERVER_ID = "local"

interface ServerContextValue {
  authHeaders: Accessor<Record<string, string>>
  serverUrl: Accessor<string>
}

const ServerContext = createContext<ServerContextValue>()

export function ServerProvider(props: ParentProps) {
  onMount(() => {
    try {
      sessionStorage.removeItem("opencode.serversCreds")
      localStorage.removeItem("opencode.servers")
    } catch {
      // Storage may be unavailable in restricted browser contexts.
    }
  })
  return (
    <ServerContext.Provider
      value={{
        authHeaders: () => ({}),
        serverUrl: getServerUrl,
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
