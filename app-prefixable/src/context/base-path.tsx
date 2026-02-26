import { createContext, useContext, type ParentProps } from "solid-js"
import { getBasePath, prefixPath, getServerUrl } from "../utils/path"

interface BasePathContextValue {
  basePath: string
  prefix: (path: string) => string
  serverUrl: string
}

const BasePathContext = createContext<BasePathContextValue>()

export function BasePathProvider(props: ParentProps & { serverUrl?: string }) {
  const basePath = getBasePath()

  const value: BasePathContextValue = {
    basePath,
    prefix: (path: string) => prefixPath(path, basePath),
    serverUrl: props.serverUrl || getServerUrl(),
  }

  return <BasePathContext.Provider value={value}>{props.children}</BasePathContext.Provider>
}

export function useBasePath() {
  const ctx = useContext(BasePathContext)
  if (!ctx) throw new Error("useBasePath must be used within BasePathProvider")
  return ctx
}
