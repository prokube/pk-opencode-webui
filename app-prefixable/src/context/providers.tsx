import { createContext, useContext, createResource, createEffect, type ParentProps, onMount } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useSDK } from "./sdk"
import { useConfig } from "./config"
import { cycleModelVariant, getConfiguredAgentVariant, resolveModelVariant } from "./model-variant"

// Storage key prefix — scoped per project directory
const MODELS_BY_AGENT_PREFIX = "opencode.modelsByAgent"
const VARIANTS_BY_SESSION_PREFIX = "opencode.variantsBySession"
// Legacy key (pre-namespacing) used for migration
const LEGACY_MODELS_KEY = "opencode.modelsByAgent"

function modelsStorageKey(directory?: string): string {
  if (!directory) return LEGACY_MODELS_KEY
  const normalized = directory.replace(/[\\/]+$/, "")
  return `${MODELS_BY_AGENT_PREFIX}.${normalized}`
}

function variantsStorageKey(directory?: string): string {
  if (!directory) return VARIANTS_BY_SESSION_PREFIX
  const normalized = directory.replace(/[\\/]+$/, "")
  return `${VARIANTS_BY_SESSION_PREFIX}.${normalized}`
}

// Validate that parsed localStorage data is a Record<string, ModelKey>
function isValidModelsByAgent(value: unknown): value is Record<string, ModelKey> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  for (const v of Object.values(value)) {
    if (!v || typeof v !== "object") return false
    if (typeof (v as ModelKey).providerID !== "string" || typeof (v as ModelKey).modelID !== "string") return false
  }
  return true
}

function normalizeVariantsBySession(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const next: Record<string, string> = {}
  for (const v of Object.values(value)) {
    if (v === null) continue
    if (typeof v !== "string") return undefined
  }
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== "string") continue
    next[k] = v
  }
  return next
}

// Fallback defaults when no config is available
const FALLBACK_PROVIDER = "opencode"
const FALLBACK_MODEL = "big-pickle"
const FALLBACK_AGENT = "build"

// Define types locally to avoid SDK type mismatches
interface Model {
  id: string
  name: string
  providerID?: string  // optional — injected during normalisation
  limit: {
    context: number
    input?: number
    output: number
  }
  variants?: Record<string, { disabled?: boolean }>
}

interface Provider {
  id: string
  name: string
  models: Record<string, Model>
}

interface Agent {
  name: string
  mode: string
  hidden?: boolean
  model?: ModelKey
  variant?: string
}

interface ProviderAuthMethod {
  type: "api" | "oauth"
  label: string
}

interface ModelKey {
  providerID: string
  modelID: string
}

interface ProviderListData {
  all: Provider[]
  connected: string[]
  default: Record<string, string>
}

interface OAuthAuthorization {
  url: string
  method: "auto" | "code"
  instructions: string
}

interface ProviderContextValue {
  providers: Provider[]
  connected: string[]
  defaults: Record<string, string>
  authMethods: Record<string, ProviderAuthMethod[]>
  agents: Agent[]
  loading: boolean
  selectedModel: ModelKey | null
  selectedAgent: string
  modelsByAgent: Record<string, ModelKey>
  setSelectedModel: (model: ModelKey | null) => void
  setSelectedAgent: (agent: string) => void
  getSessionModel: (sessionID: string) => ModelKey | null
  setSessionModel: (sessionID: string, model: ModelKey | null) => void
  variant: {
    list: (model: ModelKey | null) => string[]
    configured: (model: ModelKey | null, agent?: string) => string | undefined
    current: (sessionID: string | undefined, model: ModelKey | null, agent?: string) => string | undefined
    set: (sessionID: string | undefined, value: string | undefined) => void
    cycle: (sessionID: string | undefined, model: ModelKey | null, agent?: string) => string | undefined
  }
  refetch: () => void
  connectProvider: (providerID: string, apiKey: string) => Promise<boolean>
  disconnectProvider: (providerID: string) => Promise<boolean>
  startOAuth: (providerID: string, methodIndex: number) => Promise<OAuthAuthorization | undefined>
  completeOAuth: (providerID: string, methodIndex: number, code?: string) => Promise<boolean>
}

const ProviderContext = createContext<ProviderContextValue>()

export function ProviderProvider(props: ParentProps) {
  const { client, global: globalClient, directory } = useSDK()
  const cfg = useConfig()
  const storageKey = modelsStorageKey(directory)
  const variantKey = variantsStorageKey(directory)

  const [store, setStore] = createStore({
    modelsByAgent: {} as Record<string, ModelKey>,
    selectedAgent: FALLBACK_AGENT,
    sessionModels: {} as Record<string, ModelKey>,
    sessionVariants: {} as Record<string, string>,
  })

  // Track whether the user has manually changed the agent via setSelectedAgent
  let userChangedAgent = false
  // Track whether localStorage has been hydrated (prevents saving the initial empty store)
  let modelsHydrated = false
  let variantsHydrated = false

  // Load models from localStorage (directory-scoped key, with migration from legacy global key)
  onMount(() => {
    try {
      const stored = localStorage.getItem(storageKey)
      let loaded = false
      if (stored) {
        try {
          const parsed = JSON.parse(stored)
          if (isValidModelsByAgent(parsed)) {
            setStore("modelsByAgent", parsed)
            loaded = true
          }
        } catch (_) { /* invalid JSON, fall through to remove */ }
        if (!loaded) localStorage.removeItem(storageKey)
      }
      // Migrate: if no per-directory data exists, copy from legacy global key
      if (!loaded && directory) {
        const legacy = localStorage.getItem(LEGACY_MODELS_KEY)
        if (legacy) {
          try {
            const parsed = JSON.parse(legacy)
            if (isValidModelsByAgent(parsed)) {
              setStore("modelsByAgent", parsed)
              localStorage.setItem(storageKey, legacy)
              // Remove legacy key so other projects fall through to their opencode.json defaults
              localStorage.removeItem(LEGACY_MODELS_KEY)
            }
          } catch (_) { /* legacy key corrupted, ignore */ }
        }
      }
    } catch (e) {
      console.error("Failed to load models from storage:", e)
    }
    modelsHydrated = true

    try {
      const stored = localStorage.getItem(variantKey)
      if (stored) {
        try {
          const parsed = JSON.parse(stored)
          const normalized = normalizeVariantsBySession(parsed)
          if (normalized) {
            setStore("sessionVariants", normalized)
            variantsHydrated = true
          }
        } catch (_) { /* invalid JSON, fall through to remove */ }
        if (!variantsHydrated) localStorage.removeItem(variantKey)
      }
    } catch (e) {
      console.error("Failed to load variants from storage:", e)
    }
    variantsHydrated = true
  })

  // Save models to localStorage whenever they change (directory-scoped).
  // The hydrated guard prevents the initial empty store from overwriting persisted data.
  createEffect(() => {
    const serialized = JSON.stringify(store.modelsByAgent)
    if (!modelsHydrated) return
    try {
      localStorage.setItem(storageKey, serialized)
    } catch (e) {
      console.error("Failed to save models to storage:", e)
    }
  })

  createEffect(() => {
    const serialized = JSON.stringify(store.sessionVariants)
    if (!variantsHydrated) return
    try {
      localStorage.setItem(variantKey, serialized)
    } catch (e) {
      console.error("Failed to save variants to storage:", e)
    }
  })

  function normalizeProviderData(data: ProviderListData) {
    const all = data.all.map((provider) => ({
      ...provider,
      models: Object.fromEntries(
        Object.entries(provider.models).map(([k, m]) => [k, { ...m, providerID: provider.id }])
      ),
    }))
    return { ...data, all }
  }

  // Fetch providers
  const [providerData, { mutate: setProviderData, refetch: refetchProviders }] = createResource(async () => {
    try {
      const res = await client.provider.list()
      const data = res.data as ProviderListData | undefined
      if (!data) return undefined

      if (directory) {
        const globalRes = await globalClient.provider.list()
        const globalData = globalRes.data as ProviderListData | undefined
        const stale = (globalData?.connected ?? []).some((id) => !data.connected.includes(id))
        if (stale) {
          await client.instance.dispose()
          const refreshed = await client.provider.list()
          const refreshedData = refreshed.data as ProviderListData | undefined
          if (refreshedData) return normalizeProviderData(refreshedData)
        }
      }

      return normalizeProviderData(data)
    } catch (e) {
      console.error("Failed to fetch providers:", e)
      return undefined
    }
  })

  // Auto-select default model/agent from project config, falling back to hardcoded defaults.
  // localStorage selections take priority (user's runtime choice wins).
  createEffect(() => {
    const data = providerData()
    if (!data) return

    // Resolve default agent from config (project overrides global) or fallback,
    // validating against known agents
    const configAgent = cfg.project.default_agent || cfg.global.default_agent
    const agents = agentsData()
    const agentNames = agents ? agents.map((a) => a.name) : []
    const validConfigAgent = configAgent && agentNames.length > 0 && agentNames.includes(configAgent)
    const defaultAgent = validConfigAgent ? configAgent : FALLBACK_AGENT

    // Set selected agent if config specifies a valid agent, we're still on fallback,
    // and the user hasn't manually chosen an agent
    if (validConfigAgent && !userChangedAgent && store.selectedAgent === FALLBACK_AGENT && configAgent !== FALLBACK_AGENT) {
      setStore("selectedAgent", configAgent)
    }

    // Resolve default model from config (project overrides global). Config format is "provider/model".
    const configModel = cfg.project.model || cfg.global.model
    const slashIdx = configModel ? configModel.indexOf("/") : -1
    const parsedProvider = slashIdx > 0 ? configModel!.slice(0, slashIdx) : ""
    const parsedModel = slashIdx > 0 ? configModel!.slice(slashIdx + 1) : ""
    const hasValidConfigModel = !!(parsedProvider && parsedModel)
    const targetProvider = hasValidConfigModel ? parsedProvider : FALLBACK_PROVIDER
    const targetModel = hasValidConfigModel ? parsedModel : FALLBACK_MODEL

    // Only auto-set model when there is no existing selection for this agent
    // (localStorage or previous user choice). This prevents overriding user selections.
    if (!store.modelsByAgent[defaultAgent]) {
      let modelSet = false
      if (data.connected.includes(targetProvider)) {
        const provider = data.all.find((p) => p.id === targetProvider)
        if (provider && provider.models[targetModel]) {
          setStore("modelsByAgent", defaultAgent, { providerID: targetProvider, modelID: targetModel })
          modelSet = true
        }
      }

      // Fallback: if config model's provider isn't connected or model doesn't exist
      if (!modelSet && hasValidConfigModel) {
        if (data.connected.includes(FALLBACK_PROVIDER)) {
          const provider = data.all.find((p) => p.id === FALLBACK_PROVIDER)
          if (provider && provider.models[FALLBACK_MODEL]) {
            setStore("modelsByAgent", defaultAgent, { providerID: FALLBACK_PROVIDER, modelID: FALLBACK_MODEL })
          }
        }
      }
    }
  })

  // Fetch auth methods for all providers (returns { [providerID]: ProviderAuthMethod[] })
  const [authData] = createResource(async () => {
    try {
      const res = await client.provider.auth()
      return (res.data as Record<string, ProviderAuthMethod[]>) ?? {}
    } catch (e) {
      console.error("Failed to fetch auth methods:", e)
      return {}
    }
  })

  // Fetch agents
  const [agentsData, { refetch: refetchAgents }] = createResource(async () => {
    try {
      const res = await client.app.agents()
      // The API returns an array directly, SDK wraps it in { data: [...] }
      const agents = res.data
      if (!Array.isArray(agents)) {
        console.error("[Providers] Agents is not an array:", agents)
        return []
      }
      return agents as Agent[]
    } catch (e) {
      console.error("Failed to fetch agents:", e)
      return []
    }
  })

  function setSelectedModel(model: ModelKey | null) {
    if (model) {
      setStore("modelsByAgent", store.selectedAgent, model)
    }
  }

  function setSelectedAgent(agent: string) {
    if (!store.modelsByAgent[agent]) {
      // Resolve effective default agent consistently: project -> global -> fallback
      const configAgent = cfg.project.default_agent || cfg.global.default_agent
      const agents = agentsData()
      const agentNames = agents ? agents.map((a) => a.name) : []
      const effectiveDefault = configAgent && agentNames.includes(configAgent) ? configAgent : FALLBACK_AGENT

      const source = store.modelsByAgent[store.selectedAgent]
        ? store.selectedAgent
        : store.modelsByAgent[effectiveDefault]
          ? effectiveDefault
          : null

      if (source) {
        setStore("modelsByAgent", agent, store.modelsByAgent[source])
      }
    }
    userChangedAgent = true
    setStore("selectedAgent", agent)
  }

  function getSessionModel(sessionID: string): ModelKey | null {
    return store.sessionModels[sessionID] ?? null
  }

  function setSessionModel(sessionID: string, model: ModelKey | null) {
    if (model) {
      setStore("sessionModels", sessionID, model)
    }
  }

  function availableProviders() {
    const disabled = cfg.global.disabled_providers ?? []
    return (providerData()?.all ?? []).filter((p) => !disabled.includes(p.id))
  }

  function modelForKey(model: ModelKey | null) {
    if (!model) return undefined
    const provider = availableProviders().find((p) => p.id === model.providerID)
    if (!provider) return undefined
    const item = provider.models[model.modelID]
    if (!item) return undefined
    return { ...item, providerID: model.providerID }
  }

  function variantList(model: ModelKey | null) {
    const item = modelForKey(model)
    if (!item?.variants) return []
    return Object.entries(item.variants)
      .filter(([, config]) => !config?.disabled)
      .map(([name]) => name)
  }

  function configuredVariant(model: ModelKey | null, agent = store.selectedAgent) {
    if (!model) return undefined
    const info = modelForKey(model)
    if (!info) return undefined
    const configuredAgent = (agentsData() ?? []).find((item) => item.name === agent)
    return getConfiguredAgentVariant(configuredAgent, {
      providerID: model.providerID,
      modelID: model.modelID,
      variants: info.variants,
    })
  }

  function selectedSessionVariant(sessionID: string | undefined) {
    if (!sessionID) return undefined
    return store.sessionVariants[sessionID]
  }

  function setSessionVariant(sessionID: string | undefined, value: string | undefined) {
    if (!sessionID) return
    if (value === undefined) {
      setStore("sessionVariants", produce((state) => {
        delete state[sessionID]
      }))
      return
    }
    setStore("sessionVariants", sessionID, value)
  }

  function currentVariant(sessionID: string | undefined, model: ModelKey | null, agent = store.selectedAgent) {
    return resolveModelVariant(
      selectedSessionVariant(sessionID),
      configuredVariant(model, agent),
      variantList(model),
    )
  }

  function cycleVariant(sessionID: string | undefined, model: ModelKey | null, agent = store.selectedAgent) {
    const value = cycleModelVariant(
      selectedSessionVariant(sessionID),
      configuredVariant(model, agent),
      variantList(model),
    )
    setSessionVariant(sessionID, value)
    return value
  }

  async function connectProvider(providerID: string, apiKey: string): Promise<boolean> {
    try {
      await client.auth.set({
        providerID,
        auth: { type: "api", key: apiKey },
      })
    } catch (e) {
      console.error("Failed to connect provider:", e)
      return (await providerConnected(providerID)) === true
    }

    try {
      const connected = await waitProviderConnected(providerID, true)
      if (connected !== undefined) return connected
    } catch (e) {
      console.error("Connected provider, but failed to reload provider state:", e)
    }
    return (await providerConnected(providerID)) === true
  }

  async function disconnectProvider(providerID: string): Promise<boolean> {
    try {
      await client.auth.remove({ providerID })
    } catch (e) {
      console.error("Failed to disconnect provider:", e)
      return (await providerConnected(providerID)) === false
    }

    try {
      const connected = await waitProviderConnected(providerID, false)
      if (connected !== undefined) return connected === false
    } catch (e) {
      console.error("Disconnected provider, but failed to reload provider state:", e)
    }
    return (await providerConnected(providerID)) === false
  }

  async function providerConnected(providerID: string): Promise<boolean | undefined> {
    try {
      const res = await client.provider.list()
      const data = res.data as ProviderListData | undefined
      return data?.connected.includes(providerID)
    } catch (e) {
      console.error("Failed to check provider connection:", e)
      return undefined
    }
  }

  async function reloadProviders() {
    await client.instance.dispose()
    return await refetchProviders()
  }

  async function reloadProviderConnected(providerID: string) {
    return (await reloadProviders())?.connected.includes(providerID)
  }

  async function waitProviderConnected(providerID: string, expected: boolean) {
    await client.instance.dispose()
    for (const delay of [0, 500, 1000, 2000, 3000, 5000, 8000]) {
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
      const connected = (await refetchProviders())?.connected.includes(providerID)
      if (connected === expected) {
        updateProviderConnected(providerID, expected)
        return connected
      }
    }
    return undefined
  }

  function updateProviderConnected(providerID: string, connected: boolean) {
    setProviderData((data) => {
      if (!data) return data
      if (connected && data.connected.includes(providerID)) return data
      if (!connected && !data.connected.includes(providerID)) return data
      return {
        ...data,
        connected: connected ? [...data.connected, providerID] : data.connected.filter((id) => id !== providerID),
      }
    })
  }

  async function startOAuth(providerID: string, methodIndex: number): Promise<OAuthAuthorization | undefined> {
    try {
      const res = await client.provider.oauth.authorize({
        providerID,
        method: methodIndex,
      })
      return res.data as OAuthAuthorization | undefined
    } catch (e) {
      console.error("Failed to start OAuth:", e)
      return undefined
    }
  }

  async function completeOAuth(providerID: string, methodIndex: number, code?: string): Promise<boolean> {
    try {
      await client.provider.oauth.callback({
        providerID,
        method: methodIndex,
        code,
      })
    } catch (e) {
      console.error("Failed to complete OAuth:", e)
      return (await waitProviderConnected(providerID, true)) === true
    }

    try {
      const connected = await waitProviderConnected(providerID, true)
      if (connected !== undefined) return connected
    } catch (e) {
      console.error("Completed OAuth, but failed to reload provider state:", e)
    }
    updateProviderConnected(providerID, true)
    return true
  }

  function refetch() {
    refetchProviders()
    refetchAgents()
  }

  const value: ProviderContextValue = {
    get providers() {
      return availableProviders()
    },
    get connected() {
      const disabled = cfg.global.disabled_providers ?? []
      return (providerData()?.connected ?? []).filter((id) => !disabled.includes(id))
    },
    get defaults() {
      return providerData()?.default ?? {}
    },
    get authMethods() {
      return authData() ?? {}
    },
    get agents() {
      // Show all non-hidden agents from backend
      return (agentsData() ?? []).filter((a) => !a.hidden)
    },
    get loading() {
      return providerData.loading || agentsData.loading
    },
    get selectedModel() {
      // Return the model for the currently selected agent
      return store.modelsByAgent[store.selectedAgent] ?? null
    },
    get selectedAgent() {
      return store.selectedAgent
    },
    get modelsByAgent() {
      return store.modelsByAgent
    },
    setSelectedModel,
    setSelectedAgent,
    getSessionModel,
    setSessionModel,
    variant: {
      list: variantList,
      configured: configuredVariant,
      current: currentVariant,
      set: setSessionVariant,
      cycle: cycleVariant,
    },
    refetch,
    connectProvider,
    disconnectProvider,
    startOAuth,
    completeOAuth,
  }

  return <ProviderContext.Provider value={value}>{props.children}</ProviderContext.Provider>
}

export function useProviders() {
  const ctx = useContext(ProviderContext)
  if (!ctx) throw new Error("useProviders must be used within ProviderProvider")
  return ctx
}
