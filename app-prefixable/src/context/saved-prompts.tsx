import { createContext, useContext, createSignal, type ParentProps } from "solid-js"

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

const STORAGE_KEY = "opencode.savedPrompts"

const SavedPromptsContext = createContext<SavedPromptsContextValue>()

function loadFromStorage(): SavedPrompt[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
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

function saveToStorage(prompts: SavedPrompt[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prompts))
  } catch {
    // Ignore storage errors
  }
}

export function SavedPromptsProvider(props: ParentProps) {
  const initial = loadFromStorage().sort((a, b) => b.createdAt - a.createdAt)
  const [prompts, setPrompts] = createSignal<SavedPrompt[]>(initial)

  function add(title: string, text: string) {
    setPrompts((prev) => {
      const prompt: SavedPrompt = {
        id: crypto.randomUUID(),
        title,
        text,
        createdAt: Date.now(),
      }
      const updated = [prompt, ...prev]
      saveToStorage(updated)
      return updated
    })
  }

  function update(id: string, fields: Partial<Pick<SavedPrompt, "title" | "text">>) {
    setPrompts((prev) => {
      const updated = prev.map((p) => (p.id === id ? { ...p, ...fields } : p))
      saveToStorage(updated)
      return updated
    })
  }

  function remove(id: string) {
    setPrompts((prev) => {
      const filtered = prev.filter((p) => p.id !== id)
      saveToStorage(filtered)
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
      saveToStorage(updated)
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
