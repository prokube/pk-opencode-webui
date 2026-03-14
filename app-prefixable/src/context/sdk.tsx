import { createContext, useContext, createMemo, type ParentProps } from "solid-js"
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
  const server = useServer()

  // Create clients that use proxy fetch when external server is active
  // Track activeKey to re-create clients when server changes
  const clients = createMemo(() => {
    // Access activeKey to make this memo reactive to server changes
    const activeKey = server.activeKey()
    const proxyFetch = server.createProxyFetch()
    
    console.log("[SDK] Creating clients, activeKey:", activeKey)
    
    const client = createOpencodeClient({
      baseUrl: serverUrl,
      directory: props.directory,
      throwOnError: true,
      fetch: proxyFetch as typeof fetch,
    })

    // Global client without directory - for PTY operations, SSH keys, etc.
    const global = createOpencodeClient({
      baseUrl: serverUrl,
      throwOnError: true,
      fetch: proxyFetch as typeof fetch,
    })

    return { client, global }
  })

  return (
    <SDKContext.Provider value={{ 
      get client() { return clients().client },
      get global() { return clients().global },
      url: serverUrl, 
      directory: props.directory 
    }}>
      {props.children}
    </SDKContext.Provider>
  )
}

export function useSDK() {
  const ctx = useContext(SDKContext)
  if (!ctx) throw new Error("useSDK must be used within SDKProvider")
  return ctx
}
