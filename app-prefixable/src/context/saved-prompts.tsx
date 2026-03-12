import { createContext, useContext, createSignal, createEffect, on, type ParentProps, type Accessor } from "solid-js"

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
  // Normalize trailing separators so "/path/to/project" and "/path/to/project/" share the same key
  const normalized = directory.replace(/[\\/]+$/, "")
  return `opencode.savedPrompts.${normalized}`
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
  try {
    const projectKey = storageKey(directory)
    // Already has project-scoped data — no migration needed
    if (localStorage.getItem(projectKey)) return
    const legacy = localStorage.getItem(LEGACY_KEY)
    if (!legacy) return
    // Copy legacy data to project-scoped key; do NOT delete old key
    localStorage.setItem(projectKey, legacy)
  } catch {
    // Ignore storage errors during migration
  }
}

export function SavedPromptsProvider(props: ParentProps & { directory?: Accessor<string | undefined> }) {
  const dir = () => props.directory?.()
  const key = () => storageKey(dir())

  // Run migration synchronously before initial load so first render has data
  const initialDir = dir()
  if (initialDir) migrateIfNeeded(initialDir)

  const [prompts, setPrompts] = createSignal<SavedPrompt[]>(
    loadFromStorage(key()).sort((a, b) => b.createdAt - a.createdAt),
  )

  // Reload prompts (with migration) only when the storage key actually changes
  // (i.e. when switching projects). Using `on()` with `defer: true` prevents
  // this effect from running on initial mount (data is already loaded above)
  // and avoids clobbering in-memory signal updates from add/update/remove
  // during same-project navigation.
  createEffect(on(key, (k) => {
    const d = dir()
    if (d) migrateIfNeeded(d)
    setPrompts(loadFromStorage(k).sort((a, b) => b.createdAt - a.createdAt))
  }, { defer: true }))

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
