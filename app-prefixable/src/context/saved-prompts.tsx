import { createContext, createEffect, createMemo, createSignal, on, useContext, type ParentProps } from "solid-js"
import { createSavedPrompt, deleteSavedPrompt, readSavedPrompts, updateSavedPrompt, type PromptScope, type SavedPrompt, type SavedPromptState } from "../utils/extended-api"
import { useSDK } from "./sdk"

interface SavedPromptsContextValue {
  prompts: () => SavedPrompt[]
  global: () => SavedPrompt[]
  project: () => SavedPrompt[]
  loading: () => boolean
  saving: () => boolean
  error: () => string | undefined
  create: (title: string, text: string, scope: PromptScope) => Promise<boolean>
  update: (id: string, patch: Partial<Pick<SavedPrompt, "title" | "text" | "scope">>) => Promise<boolean>
  remove: (id: string) => Promise<boolean>
}

const SavedPromptsContext = createContext<SavedPromptsContextValue>()

export function SavedPromptsProvider(props: ParentProps) {
  const sdk = useSDK()
  const [state, setState] = createSignal<SavedPromptState>({ global: [], project: [] })
  const [loading, setLoading] = createSignal(true)
  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal<string>()
  let version = 0
  let queue = Promise.resolve()
  let pending = 0

  async function load() {
    const current = ++version
    setLoading(true)
    setError()
    setState({ global: [], project: [] })
    const next = await readSavedPrompts(sdk.url, sdk.directory).catch((cause) => {
      console.error("[saved-prompts] load failed", cause)
      return null
    })
    if (current !== version) return
    setLoading(false)
    if (!next) {
      setError("Failed to load saved prompts.")
      return
    }
    setState(next)
  }

  createEffect(on(() => sdk.directory, load))

  function mutate(run: (directory?: string) => Promise<SavedPromptState>) {
    const directory = sdk.directory
    const current = ++version
    setLoading(false)
    pending += 1
    setSaving(true)
    setError()
    const result = queue.catch(() => undefined).then(() => run(directory)).then((next) => {
      if (current !== version || directory !== sdk.directory) return true
      setState(next)
      return true
    }).catch((cause) => {
      console.error("[saved-prompts] mutation failed", cause)
      setError("Failed to save prompts. Please retry.")
      return false
    }).finally(() => {
      pending -= 1
      setSaving(pending > 0)
    })
    queue = result.then(() => undefined)
    return result
  }

  const value: SavedPromptsContextValue = {
    prompts: createMemo(() => [...state().project, ...state().global]),
    global: () => state().global,
    project: () => state().project,
    loading,
    saving,
    error,
    create: (title, text, scope) => mutate((directory) => createSavedPrompt(sdk.url, directory, { title, text, scope })),
    update: (id, patch) => mutate((directory) => updateSavedPrompt(sdk.url, directory, id, patch)),
    remove: (id) => mutate((directory) => deleteSavedPrompt(sdk.url, directory, id)),
  }

  return <SavedPromptsContext.Provider value={value}>{props.children}</SavedPromptsContext.Provider>
}

export function useSavedPrompts() {
  const context = useContext(SavedPromptsContext)
  if (!context) throw new Error("useSavedPrompts must be used within SavedPromptsProvider")
  return context
}
