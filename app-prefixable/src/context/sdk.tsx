import { createContext, useContext, type ParentProps } from "solid-js"
import { createOpencodeClient } from "../sdk/client"
import { useBasePath } from "./base-path"
import { useServer } from "./server"

type SDKClient = ReturnType<typeof createOpencodeClient>

interface SDKContextValue {
  client: SDKClient
  /** Global client without directory context - for operations that should work regardless of project */
  global: SDKClient
  url: string
  directory?: string
}

const SDKContext = createContext<SDKContextValue>()

export function SDKProvider(props: ParentProps & { directory?: string }) {
  const { serverUrl } = useBasePath()
  const { authHeaders } = useServer()

  const client = createOpencodeClient({
    baseUrl: serverUrl,
    directory: props.directory,
    headers: authHeaders(),
    throwOnError: true,
  })

  // Global client without directory - for PTY operations, SSH keys, etc.
  const global = createOpencodeClient({
    baseUrl: serverUrl,
    headers: authHeaders(),
    throwOnError: true,
  })

  return (
    <SDKContext.Provider value={{ client, global, url: serverUrl, directory: props.directory }}>
      {props.children}
    </SDKContext.Provider>
  )
}

export function useSDK() {
  const ctx = useContext(SDKContext)
  if (!ctx) throw new Error("useSDK must be used within SDKProvider")
  return ctx
}
