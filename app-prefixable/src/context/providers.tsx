import { createContext, useContext, createResource, createEffect, type ParentProps, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { useSDK } from "./sdk"
import { useConfig } from "./config"

// Storage key prefix — scoped per project directory
const MODELS_BY_AGENT_PREFIX = "opencode.modelsByAgent"
// Legacy key (pre-namespacing) used for migration
const LEGACY_MODELS_KEY = "opencode.modelsByAgent"

function modelsStorageKey(directory?: string): string {
  if (!directory) return LEGACY_MODELS_KEY
  const normalized = directory.replace(/[\\/]+$/, "")
  return `${MODELS_BY_AGENT_PREFIX}.${normalized}`
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
  refetch: () => void
  connectProvider: (providerID: string, apiKey: string) => Promise<boolean>
  startOAuth: (providerID: string, methodIndex: number) => Promise<OAuthAuthorization | undefined>
  completeOAuth: (providerID: string, methodIndex: number, code?: string) => Promise<boolean>
}

const ProviderContext = createContext<ProviderContextValue>()

export function ProviderProvider(props: ParentProps) {
  const { client, directory } = useSDK()
  const cfg = useConfig()
  const storageKey = modelsStorageKey(directory)

  const [store, setStore] = createStore({
    modelsByAgent: {} as Record<string, ModelKey>,
    selectedAgent: FALLBACK_AGENT,
  })

  // Track whether the user has manually changed the agent via setSelectedAgent
  let userChangedAgent = false
  // Track whether localStorage has been hydrated (prevents saving the initial empty store)
  let hydrated = false

  // Load models from localStorage (directory-scoped key, with migration from legacy global key)
  onMount(() => {
    try {
      const stored = localStorage.getItem(storageKey)
      if (stored) {
        try {
          const parsed = JSON.parse(stored)
          if (isValidModelsByAgent(parsed)) {
            setStore("modelsByAgent", parsed)
            hydrated = true
            return
          }
        } catch (_) { /* invalid JSON, fall through to remove */ }
        localStorage.removeItem(storageKey)
      }
      // Migrate: if no per-directory data exists, copy from legacy global key
      if (!directory) { hydrated = true; return }
      const legacy = localStorage.getItem(LEGACY_MODELS_KEY)
      if (!legacy) { hydrated = true; return }
      try {
        const parsed = JSON.parse(legacy)
        if (isValidModelsByAgent(parsed)) {
          setStore("modelsByAgent", parsed)
          localStorage.setItem(storageKey, legacy)
        }
      } catch (_) { /* legacy key corrupted, ignore */ }
    } catch (e) {
      console.error("Failed to load models from storage:", e)
    }
    hydrated = true
  })

  // Save models to localStorage whenever they change (directory-scoped).
  // The hydrated guard prevents the initial empty store from overwriting persisted data.
  createEffect(() => {
    const serialized = JSON.stringify(store.modelsByAgent)
    if (!hydrated) return
    try {
      localStorage.setItem(storageKey, serialized)
    } catch (e) {
      console.error("Failed to save models to storage:", e)
    }
  })

  // Fetch providers
  const [providerData, { refetch: refetchProviders }] = createResource(async () => {
    try {
      const res = await client.provider.list()
      const data = res.data as ProviderListData | undefined
      if (!data) return undefined
      // Inject providerID into each model since the SDK response doesn't include it
      const all = data.all.map((provider) => ({
        ...provider,
        models: Object.fromEntries(
          Object.entries(provider.models).map(([k, m]) => [k, { ...m, providerID: provider.id }])
        ),
      }))
      return { ...data, all }
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

  async function connectProvider(providerID: string, apiKey: string): Promise<boolean> {
    try {
      await client.auth.set({
        providerID,
        auth: { type: "api", key: apiKey },
      })
      // Dispose instance to reload provider state, then refresh
      await client.instance.dispose()
      await refetchProviders()
      return true
    } catch (e) {
      console.error("Failed to connect provider:", e)
      return false
    }
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
      // Dispose instance to reload provider state, then refresh
      await client.instance.dispose()
      await refetchProviders()
      return true
    } catch (e) {
      console.error("Failed to complete OAuth:", e)
      return false
    }
  }

  function refetch() {
    refetchProviders()
    refetchAgents()
  }

  const value: ProviderContextValue = {
    get providers() {
      return providerData()?.all ?? []
    },
    get connected() {
      return providerData()?.connected ?? []
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
    refetch,
    connectProvider,
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
