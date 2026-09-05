import { createContext, createEffect, createMemo, createSignal, on, onCleanup, useContext, type ParentProps } from "solid-js"
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

function legacyPromptList(raw: string | null, scope: PromptScope) {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((item): SavedPrompt[] => {
      if (!item || typeof item !== "object") return []
      const row = item as Record<string, unknown>
      if (typeof row.id !== "string" || typeof row.title !== "string" || typeof row.text !== "string" || typeof row.createdAt !== "number") return []
      const storedScope = row.scope === "global" || row.scope === "project" ? row.scope : scope
      return [{ id: row.id, title: row.title, text: row.text, createdAt: row.createdAt, scope: storedScope }]
    })
  } catch {
    return []
  }
}

export function legacyPromptKeys(directory?: string) {
  const project = directory?.trim().replace(/[\\/]+$/, "")
  return ["opencode.savedPrompts", ...(project ? [`opencode.savedPrompts.${project}`] : [])]
}

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
    const directory = sdk.directory
    setLoading(true)
    setError()
    setState({ global: [], project: [] })
    const next = await readSavedPrompts(sdk.url, directory).catch((cause) => {
      console.error("[saved-prompts] load failed", cause)
      return null
    })
    if (current !== version) return
    if (!next) {
      setLoading(false)
      setError("Failed to load saved prompts.")
      return
    }
    const keys = legacyPromptKeys(directory)
    const legacyRaw = (() => {
      try {
        return keys.map((key) => localStorage.getItem(key))
      } catch {
        return keys.map(() => null)
      }
    })()
    const legacy = (() => {
      return [
        ...legacyPromptList(legacyRaw[0], "global"),
        ...(keys[1] ? legacyPromptList(legacyRaw[1], "project") : []),
      ]
    })()
    const projectIDs = new Set(legacy.filter((prompt) => prompt.scope === "project").map((prompt) => prompt.id))
    const conflicts = legacy.filter((prompt) => prompt.scope === "global" && projectIDs.has(prompt.id))
    if (conflicts.length) {
      setLoading(false)
      setState(next)
      setError("Legacy prompts contain conflicting IDs across scopes. Resolve or remove the legacy browser entries before retrying.")
      return
    }
    const existing = new Map([...next.global, ...next.project].map((prompt) => [prompt.id, prompt]))
    const deferred = legacy.some((prompt) => prompt.scope === "project" && !directory)
    const pending = legacy.filter((prompt) => {
      if (prompt.scope === "project" && !directory) return false
      const stored = existing.get(prompt.id)
      const exact = stored && stored.title === prompt.title && stored.text === prompt.text && stored.createdAt === prompt.createdAt && stored.scope === prompt.scope
      return !exact && (prompt.scope === "project" || !projectIDs.has(prompt.id))
    })
    const migrated = await pending.reduce(async (result, prompt) => {
      const migration = await result
      if (current !== version) return { ...migration, cancelled: true }
      const state = await createSavedPrompt(sdk.url, directory, prompt).catch(() => null)
      return { state: state ?? migration.state, ok: migration.ok && !!state, cancelled: false }
    }, Promise.resolve({ state: next as SavedPromptState, ok: true, cancelled: false }))
    if (current !== version) return
    if (migrated.cancelled) return
    if (!migrated.ok) {
      setLoading(false)
      setState(migrated.state)
      setError("Failed to migrate saved prompts. Please retry.")
      return
    }
    if (legacy.length && !deferred) {
      try {
        keys.forEach((key, index) => {
          if (localStorage.getItem(key) === legacyRaw[index]) localStorage.removeItem(key)
        })
      } catch {
        // Backend migration succeeded; stale browser storage is harmless.
      }
    }
    setState(migrated.state)
    setLoading(false)
  }

  createEffect(on(() => sdk.directory, load))
  onCleanup(() => {
    version += 1
  })

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
