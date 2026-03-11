import { createContext, useContext, createSignal, onMount, onCleanup, type ParentProps } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useSDK } from "./sdk"
import { useEvents } from "./events"
import type { Config, PermissionConfig, PermissionActionConfig, PermissionRuleConfig } from "../sdk/client"

interface ConfigContextValue {
  /** Project-scoped config (from opencode.json in project root) */
  project: Config
  /** Global config (from ~/.config/opencode/opencode.json) */
  global: Config
  loading: () => boolean
  /** True only during the very first config fetch (before any data is available) */
  initialLoading: () => boolean
  error: () => string | null
  /** Update project config (deep merge). Returns updated config or null on error. */
  updateProject: (patch: Config) => Promise<Config | null>
  /** Update global config (deep merge). Returns updated config or null on error. */
  updateGlobal: (patch: Config) => Promise<Config | null>
  /** Reload both configs from the backend */
  refresh: () => Promise<void>
}

const ConfigContext = createContext<ConfigContextValue>()

export function ConfigProvider(props: ParentProps) {
  const sdk = useSDK()
  const events = useEvents()
  const [project, setProject] = createStore<Config>({})
  const [global, setGlobal] = createStore<Config>({})
  const [loading, setLoading] = createSignal(true)
  const [initialLoading, setInitialLoading] = createSignal(true)
  const [error, setError] = createSignal<string | null>(null)

  let refreshSeq = 0
  let lastUpdateAt = 0

  async function refresh() {
    const seq = ++refreshSeq
    setLoading(true)
    setError(null)
    const errors: string[] = []
    // Only fetch project config when a directory is set; otherwise treat as empty
    if (sdk.directory) {
      try {
        const projRes = await sdk.client.config.get()
        if (seq !== refreshSeq) return // superseded by newer refresh
        setProject(reconcile((projRes?.data as Config) ?? {}))
      } catch (e) {
        console.error("[Config] Failed to fetch project config:", e)
        if (seq !== refreshSeq) return
        setProject(reconcile({}))
        errors.push("project")
      }
    } else {
      setProject(reconcile({}))
    }
    try {
      const globalRes = await sdk.client.global.config.get()
      if (seq !== refreshSeq) return
      setGlobal(reconcile((globalRes?.data as Config) ?? {}))
    } catch (e) {
      console.error("[Config] Failed to fetch global config:", e)
      if (seq !== refreshSeq) return
      setGlobal(reconcile({}))
      errors.push("global")
    }
    if (errors.length > 0) {
      setError(`Failed to load ${errors.join(" and ")} configuration`)
    }
    setInitialLoading(false)
    setLoading(false)
  }

  async function updateProject(patch: Config): Promise<Config | null> {
    lastUpdateAt = Date.now()
    setError(null)
    try {
      const res = await sdk.client.config.update({ config: patch })
      const data = res.data as Config | undefined
      if (data) {
        setProject(reconcile(data))
        return data
      }
      return null
    } catch (e) {
      console.error("[Config] Failed to update project config:", e)
      setError("Failed to save project configuration")
      return null
    }
  }

  async function updateGlobal(patch: Config): Promise<Config | null> {
    lastUpdateAt = Date.now()
    setError(null)
    try {
      const res = await sdk.client.global.config.update({ config: patch })
      const data = res.data as Config | undefined
      if (data) {
        setGlobal(reconcile(data))
        return data
      }
      return null
    } catch (e) {
      console.error("[Config] Failed to update global config:", e)
      setError("Failed to save global configuration")
      return null
    }
  }

  let refreshTimer: number | undefined

  onMount(() => {
    refresh()
  })

  // Refresh config when server reconnects (e.g. after config file changes).
  // Skip if we just did an API update — our response already has the latest data
  // and re-fetching risks returning stale data from a restarting server.
  const unsub = events.subscribe((event) => {
    if (event.type === "server.connected") {
      if (Date.now() - lastUpdateAt < 5000) return
      if (refreshTimer !== undefined) clearTimeout(refreshTimer)
      refreshTimer = window.setTimeout(() => {
        refreshTimer = undefined
        refresh()
      }, 500)
    }
  })

  onCleanup(() => {
    unsub()
    if (refreshTimer !== undefined) clearTimeout(refreshTimer)
  })

  return (
    <ConfigContext.Provider
      value={{
        project,
        global,
        loading,
        initialLoading,
        error,
        updateProject,
        updateGlobal,
        refresh,
      }}
    >
      {props.children}
    </ConfigContext.Provider>
  )
}

export function useConfig() {
  const ctx = useContext(ConfigContext)
  if (!ctx) throw new Error("useConfig must be used within ConfigProvider")
  return ctx
}

// ── Helper types re-exported for convenience ──

export type { Config, PermissionConfig, PermissionActionConfig, PermissionRuleConfig }
