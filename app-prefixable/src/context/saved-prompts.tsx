import { createContext, useContext, createSignal, createEffect, on, type ParentProps, type Accessor } from "solid-js"
import { deriveDirectoryFromPathname } from "../utils/path"

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
  // Keep a "sticky" directory that survives transient undefined flickers
  // during SolidJS router transitions (e.g. project → project settings).
  //
  // Initialise from the prop, falling back to the URL-derived directory.
  // This avoids starting with undefined when the prop signal hasn't
  // settled yet but the URL already encodes the directory.
  const [sticky, setSticky] = createSignal<string | undefined>(
    props.directory?.() ?? deriveDirectoryFromPathname(),
  )

  // Track a pending clear so we can cancel it if the directory reappears
  // before the microtask fires (avoids stale-closure clears).
  let pendingClear = false

  createEffect(() => {
    const d = props.directory?.()
    if (d) {
      pendingClear = false
      setSticky(d)
      return
    }
    // Directory became undefined — check whether the URL still indicates a
    // project route.  If the URL also shows no directory, schedule a
    // microtask-delayed clear to confirm the state is stable (the pathname
    // can briefly flash to `/` during SolidJS router transitions).
    const fromUrl = deriveDirectoryFromPathname()
    if (fromUrl) {
      // URL still has a directory even though the prop is undefined;
      // keep the sticky value (may be a transient prop flicker).
      pendingClear = false
      setSticky(fromUrl)
      return
    }
    if (sticky() !== undefined) {
      pendingClear = true
      queueMicrotask(() => {
        if (!pendingClear) return
        if (props.directory?.() !== undefined) return
        if (deriveDirectoryFromPathname() !== undefined) return
        setSticky(undefined)
      })
    }
  })

  const dir = sticky
  const key = () => storageKey(dir())

  // Run migration synchronously before initial load so first render has data
  const initialDir = dir()
  if (initialDir) migrateIfNeeded(initialDir)

  const initialKey = key()
  const [prompts, setPrompts] = createSignal<SavedPrompt[]>(
    loadFromStorage(initialKey).sort((a, b) => b.createdAt - a.createdAt),
  )

  // Reload prompts (with migration) when the storage key changes (e.g.
  // switching projects or the sticky directory settling after mount).
  // We track the previous key to skip redundant reloads — this replaces
  // the old `defer: true` approach that could miss corrections when the
  // provider remounted with a stale initial key.
  let prevKey = initialKey
  createEffect(on(key, (k) => {
    if (k === prevKey) return
    prevKey = k
    const d = dir()
    if (d) migrateIfNeeded(d)
    setPrompts(loadFromStorage(k).sort((a, b) => b.createdAt - a.createdAt))
  }))

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
