import { createContext, useContext, createResource, createEffect, type ParentProps, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { useSDK } from "./sdk"
import { useConfig } from "./config"

// Storage key
const MODELS_BY_AGENT_KEY = "opencode.modelsByAgent"

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
  const { client } = useSDK()
  const cfg = useConfig()

  const [store, setStore] = createStore({
    modelsByAgent: {} as Record<string, ModelKey>,
    selectedAgent: FALLBACK_AGENT,
  })

  // Load models from localStorage
  onMount(() => {
    try {
      const stored = localStorage.getItem(MODELS_BY_AGENT_KEY)
      if (stored) {
        const parsed = JSON.parse(stored)
        setStore("modelsByAgent", parsed)
      }
    } catch (e) {
      console.error("Failed to load models from storage:", e)
    }
  })

  // Save models to localStorage whenever they change
  createEffect(() => {
    try {
      localStorage.setItem(MODELS_BY_AGENT_KEY, JSON.stringify(store.modelsByAgent))
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

    // Resolve default agent from config or fallback, validating against known agents
    const configAgent = cfg.project.default_agent
    const agents = agentsData()
    const agentNames = agents ? agents.map((a) => a.name) : []
    const validConfigAgent = configAgent && agentNames.length > 0 && agentNames.includes(configAgent)
    const defaultAgent = validConfigAgent ? configAgent : FALLBACK_AGENT

    // Set selected agent if config specifies a valid agent and we're still on fallback
    if (validConfigAgent && store.selectedAgent === FALLBACK_AGENT && configAgent !== FALLBACK_AGENT) {
      setStore("selectedAgent", configAgent)
    }

    // Resolve default model from config. Config format is "provider/model".
    const configModel = cfg.project.model
    const validConfigModel = configModel && configModel.includes("/") && configModel.split("/")[0] && configModel.split("/").slice(1).join("/")
    const targetProvider = validConfigModel ? configModel.split("/")[0] : FALLBACK_PROVIDER
    const targetModel = validConfigModel ? configModel.split("/").slice(1).join("/") : FALLBACK_MODEL

    if (data.connected.includes(targetProvider)) {
      const provider = data.all.find((p) => p.id === targetProvider)
      if (provider && provider.models[targetModel]) {
        // Only set default model if not already set (localStorage takes priority)
        if (!store.modelsByAgent[defaultAgent]) {
          setStore("modelsByAgent", defaultAgent, { providerID: targetProvider, modelID: targetModel })
        }
      }
    }

    // Fallback: if config model's provider isn't connected, try the hardcoded default
    if (validConfigModel && !data.connected.includes(targetProvider)) {
      if (data.connected.includes(FALLBACK_PROVIDER)) {
        const provider = data.all.find((p) => p.id === FALLBACK_PROVIDER)
        if (provider && provider.models[FALLBACK_MODEL] && !store.modelsByAgent[defaultAgent]) {
          setStore("modelsByAgent", defaultAgent, { providerID: FALLBACK_PROVIDER, modelID: FALLBACK_MODEL })
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
      const defaultAgent = cfg.project.default_agent || FALLBACK_AGENT
      const source = store.modelsByAgent[store.selectedAgent]
        ? store.selectedAgent
        : store.modelsByAgent[defaultAgent]
          ? defaultAgent
          : null

      if (source) {
        setStore("modelsByAgent", agent, store.modelsByAgent[source])
      }
    }
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
