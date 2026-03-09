import { createContext, useContext, createSignal, createEffect, type ParentProps, type Accessor } from "solid-js"

interface SavedPrompt {
  id: string
  title: string
  text: string
  createdAt: number
}

interface SavedPromptsContextValue {
  prompts: () => SavedPrompt[]
  add: (title: string, text: string) => void
  update: (id: string, fields: Partial<Pick<SavedPrompt, "title" | "text">>) => void
  remove: (id: string) => void
  reorder: (ids: string[]) => void
}

const LEGACY_KEY = "opencode.savedPrompts"

function storageKey(directory?: string): string {
  if (!directory) return LEGACY_KEY
  return `opencode.savedPrompts.${directory}`
}

const SavedPromptsContext = createContext<SavedPromptsContextValue>()

function loadFromStorage(key: string): SavedPrompt[] {
  try {
    const stored = localStorage.getItem(key)
    if (!stored) return []
    const parsed = JSON.parse(stored)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (p): p is SavedPrompt =>
        typeof p.id === "string" &&
        typeof p.title === "string" &&
        typeof p.text === "string" &&
        typeof p.createdAt === "number",
    )
  } catch {
    return []
  }
}

function saveToStorage(key: string, prompts: SavedPrompt[]) {
  try {
    localStorage.setItem(key, JSON.stringify(prompts))
  } catch {
    // Ignore storage errors
  }
}

/** Migrate legacy prompts to the project-scoped key (one-time, non-destructive). */
function migrateIfNeeded(directory: string) {
  const projectKey = storageKey(directory)
  // Already has project-scoped data — no migration needed
  if (localStorage.getItem(projectKey)) return
  const legacy = localStorage.getItem(LEGACY_KEY)
  if (!legacy) return
  // Copy legacy data to project-scoped key; do NOT delete old key
  localStorage.setItem(projectKey, legacy)
}

export function SavedPromptsProvider(props: ParentProps & { directory?: Accessor<string | undefined> }) {
  const dir = () => props.directory?.()
  const key = () => storageKey(dir())

  // Run migration when a directory is available
  createEffect(() => {
    const d = dir()
    if (d) migrateIfNeeded(d)
  })

  const [prompts, setPrompts] = createSignal<SavedPrompt[]>(
    loadFromStorage(key()).sort((a, b) => b.createdAt - a.createdAt),
  )

  // Reload prompts when the directory (and thus the storage key) changes
  createEffect(() => {
    const k = key()
    setPrompts(loadFromStorage(k).sort((a, b) => b.createdAt - a.createdAt))
  })

  function add(title: string, text: string) {
    setPrompts((prev) => {
      const prompt: SavedPrompt = {
        id: crypto.randomUUID(),
        title,
        text,
        createdAt: Date.now(),
      }
      const updated = [prompt, ...prev]
      saveToStorage(key(), updated)
      return updated
    })
  }

  function update(id: string, fields: Partial<Pick<SavedPrompt, "title" | "text">>) {
    setPrompts((prev) => {
      const updated = prev.map((p) => (p.id === id ? { ...p, ...fields } : p))
      saveToStorage(key(), updated)
      return updated
    })
  }

  function remove(id: string) {
    setPrompts((prev) => {
      const filtered = prev.filter((p) => p.id !== id)
      saveToStorage(key(), filtered)
      return filtered
    })
  }

  function reorder(ids: string[]) {
    setPrompts((prev) => {
      const map = new Map(prev.map((p) => [p.id, p]))
      const reordered = ids.map((id) => map.get(id)).filter(Boolean) as SavedPrompt[]
      // Append any prompts not in the ids list (shouldn't happen, but be safe)
      const remaining = prev.filter((p) => !ids.includes(p.id))
      const updated = [...reordered, ...remaining]
      saveToStorage(key(), updated)
      return updated
    })
  }

  return (
    <SavedPromptsContext.Provider value={{ prompts, add, update, remove, reorder }}>
      {props.children}
    </SavedPromptsContext.Provider>
  )
}

export function useSavedPrompts() {
  const ctx = useContext(SavedPromptsContext)
  if (!ctx) throw new Error("useSavedPrompts must be used within SavedPromptsProvider")
  return ctx
}
