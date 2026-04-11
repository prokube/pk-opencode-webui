import { createContext, useContext, createSignal, createEffect, createMemo, on, type ParentProps, type Accessor } from "solid-js"
import { deriveDirectoryFromPathname } from "../utils/path"

export type PromptScope = "global" | "project"

export interface SavedPrompt {
  id: string
  title: string
  text: string
  createdAt: number
  scope: PromptScope
}

/** Shape stored in localStorage (scope is optional for backwards compat). */
interface StoredPrompt {
  id: string
  title: string
  text: string
  createdAt: number
  scope?: PromptScope
}

interface SavedPromptsContextValue {
  /** All visible prompts (global + project-scoped, sorted newest first). */
  prompts: () => SavedPrompt[]
  /** Only global prompts. */
  globalPrompts: () => SavedPrompt[]
  /** Only project-scoped prompts. */
  projectPrompts: () => SavedPrompt[]
  /** Whether there is an active project directory. */
  hasProject: () => boolean
  add: (title: string, text: string, scope?: PromptScope) => void
  move: (id: string, scope: PromptScope) => void
  update: (id: string, fields: Partial<Pick<SavedPrompt, "title" | "text">>) => void
  remove: (id: string) => void
  reorder: (ids: string[]) => void
}

const GLOBAL_KEY = "opencode.savedPrompts"

function projectKey(directory: string): string {
  const normalized = directory.replace(/[\\/]+$/, "")
  return `opencode.savedPrompts.${normalized}`
}

const SavedPromptsContext = createContext<SavedPromptsContextValue>()

function loadFromStorage(key: string, defaultScope: PromptScope): SavedPrompt[] {
  try {
    const stored = localStorage.getItem(key)
    if (!stored) return []
    const parsed = JSON.parse(stored)
    if (!Array.isArray(parsed)) return []
    return (parsed as StoredPrompt[])
      .filter(
        (p) =>
          typeof p.id === "string" &&
          typeof p.title === "string" &&
          typeof p.text === "string" &&
          typeof p.createdAt === "number",
      )
      .map((p) => ({
        id: p.id,
        title: p.title,
        text: p.text,
        createdAt: p.createdAt,
        scope: p.scope === "global" || p.scope === "project" ? p.scope : defaultScope,
      }))
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

const sortNewest = (a: SavedPrompt, b: SavedPrompt) => b.createdAt - a.createdAt

/**
 * Migration helper that backfills missing `scope` tags in both stores.
 *
 * We intentionally keep legacy prompts in the global store and do not copy
 * them into project storage.
 */
function migrateIfNeeded(directory: string) {
  try {
    const pKey = projectKey(directory)
    // Already has project-scoped data — just ensure scope tags exist
    const existing = localStorage.getItem(pKey)
    if (existing) {
      const parsed = JSON.parse(existing)
      if (Array.isArray(parsed)) {
        let needsWrite = false
        for (const p of parsed) {
          if (!p.scope) {
            p.scope = "project"
            needsWrite = true
          }
        }
        if (needsWrite) localStorage.setItem(pKey, JSON.stringify(parsed))
      }
    }
  } catch {
    // Ignore storage errors during migration
  }

  // Ensure global key entries have scope tag
  try {
    const raw = localStorage.getItem(GLOBAL_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        let needsWrite = false
        for (const p of parsed) {
          if (!p.scope) {
            p.scope = "global"
            needsWrite = true
          }
        }
        if (needsWrite) localStorage.setItem(GLOBAL_KEY, JSON.stringify(parsed))
      }
    }
  } catch {
    // Ignore
  }
}

/**
 * Deduplicate prompts that exist in both the global and project stores
 * (artefact of the old migration that copied everything).  When duplicate
 * IDs are found, keep the project-scoped copy and drop the global one from
 * the merged view — the global store itself is left untouched.
 */
function mergePrompts(global: SavedPrompt[], project: SavedPrompt[]): SavedPrompt[] {
  const projectIds = new Set(project.map((p) => p.id))
  const dedupedGlobal = global.filter((p) => !projectIds.has(p.id))
  return [...dedupedGlobal, ...project].sort(sortNewest)
}

function isPrompt(p: SavedPrompt | undefined): p is SavedPrompt {
  return p !== undefined
}

export function SavedPromptsProvider(props: ParentProps & { directory?: Accessor<string | undefined> }) {
  // Keep a "sticky" directory that survives transient undefined flickers
  // during SolidJS router transitions (e.g. project → project settings).
  const [sticky, setSticky] = createSignal<string | undefined>(
    props.directory?.() ?? deriveDirectoryFromPathname(),
  )

  let pendingClear = false

  createEffect(() => {
    const d = props.directory?.()
    if (d) {
      pendingClear = false
      setSticky(d)
      return
    }
    const fromUrl = deriveDirectoryFromPathname()
    if (fromUrl) {
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
  const pKey = () => {
    const d = dir()
    return d ? projectKey(d) : undefined
  }

  // Run migration synchronously before initial load so first render has data
  const initialDir = dir()
  if (initialDir) migrateIfNeeded(initialDir)

  // Load initial data from both stores
  const [globalPrompts, setGlobalPrompts] = createSignal<SavedPrompt[]>(
    loadFromStorage(GLOBAL_KEY, "global").sort(sortNewest),
  )
  const initialPKey = pKey()
  const [projectPrompts, setProjectPrompts] = createSignal<SavedPrompt[]>(
    initialPKey ? loadFromStorage(initialPKey, "project").sort(sortNewest) : [],
  )

  // Merged view: global + project (deduplicated)
  const allPrompts = createMemo(() => mergePrompts(globalPrompts(), projectPrompts()))

  // Reload project prompts when the project key changes
  let prevPKey = pKey()
  createEffect(on(pKey, (k) => {
    if (k === prevPKey) return
    prevPKey = k
    const d = dir()
    if (d) migrateIfNeeded(d)
    setProjectPrompts(k ? loadFromStorage(k, "project").sort(sortNewest) : [])
  }))

  // Also reload global prompts when the project key changes (migration may
  // have tagged previously-unscoped prompts)
  createEffect(on(pKey, () => {
    setGlobalPrompts(loadFromStorage(GLOBAL_KEY, "global").sort(sortNewest))
  }))

  function add(title: string, text: string, scope: PromptScope = "global") {
    const prompt: SavedPrompt = {
      id: crypto.randomUUID(),
      title,
      text,
      createdAt: Date.now(),
      scope,
    }
    if (scope === "project") {
      const k = pKey()
      if (!k) {
        // Fallback to global if no project context
        addGlobal(prompt)
        return
      }
      setProjectPrompts((prev) => {
        const updated = [prompt, ...prev]
        saveToStorage(k, updated)
        return updated
      })
    } else {
      addGlobal(prompt)
    }
  }

  function addGlobal(prompt: SavedPrompt) {
    setGlobalPrompts((prev) => {
      const updated = [{ ...prompt, scope: "global" as const }, ...prev]
      saveToStorage(GLOBAL_KEY, updated)
      return updated
    })
  }

  function move(id: string, scope: PromptScope) {
    const project = projectPrompts().find((p) => p.id === id)
    if (project) {
      if (scope === "project") return
      const k = pKey()
      if (!k) return
      setProjectPrompts((prev) => {
        const updated = prev.filter((p) => p.id !== id)
        saveToStorage(k, updated)
        return updated
      })
      addGlobal({ ...project, scope: "global" as const })
      return
    }

    const global = globalPrompts().find((p) => p.id === id)
    if (!global) return
    if (scope === "global") return

    const k = pKey()
    if (!k) return

    setGlobalPrompts((prev) => {
      const updated = prev.filter((p) => p.id !== id)
      saveToStorage(GLOBAL_KEY, updated)
      return updated
    })
    setProjectPrompts((prev) => {
      const updated = [{ ...global, scope: "project" as const }, ...prev]
      saveToStorage(k, updated)
      return updated
    })
  }

  function update(id: string, fields: Partial<Pick<SavedPrompt, "title" | "text">>) {
    // Find which store the prompt belongs to
    if (projectPrompts().some((p) => p.id === id)) {
      const k = pKey()
      if (!k) return
      setProjectPrompts((prev) => {
        const updated = prev.map((p) => (p.id === id ? { ...p, ...fields } : p))
        saveToStorage(k, updated)
        return updated
      })
    } else {
      setGlobalPrompts((prev) => {
        const updated = prev.map((p) => (p.id === id ? { ...p, ...fields } : p))
        saveToStorage(GLOBAL_KEY, updated)
        return updated
      })
    }
  }

  function remove(id: string) {
    // Remove from whichever store contains it
    if (projectPrompts().some((p) => p.id === id)) {
      const k = pKey()
      if (!k) return
      setProjectPrompts((prev) => {
        const filtered = prev.filter((p) => p.id !== id)
        saveToStorage(k, filtered)
        return filtered
      })
    } else {
      setGlobalPrompts((prev) => {
        const filtered = prev.filter((p) => p.id !== id)
        saveToStorage(GLOBAL_KEY, filtered)
        return filtered
      })
    }
  }

  function reorder(ids: string[]) {
    // Reorder only applies to visible merged prompts.
    // Persist per-store ordering without dropping hidden duplicate entries.
    const merged = allPrompts()
    const map = new Map(merged.map((p) => [p.id, p]))
    const reordered = ids.map((id) => map.get(id)).filter(isPrompt)
    const remaining = merged.filter((p) => !ids.includes(p.id))
    const visible = [...reordered, ...remaining]
    const rank = new Map(visible.map((p, i) => [p.id, i]))

    const reorderStore = (items: SavedPrompt[]) => {
      const indexed = items.map((p, i) => ({ p, i }))
      indexed.sort((a, b) => {
        const ar = rank.get(a.p.id)
        const br = rank.get(b.p.id)
        if (ar !== undefined && br !== undefined) {
          if (ar !== br) return ar - br
          return a.i - b.i
        }
        if (ar !== undefined) return -1
        if (br !== undefined) return 1
        return a.i - b.i
      })
      return indexed.map((x) => x.p)
    }

    const newGlobal = reorderStore(globalPrompts())
    setGlobalPrompts(newGlobal)
    saveToStorage(GLOBAL_KEY, newGlobal)

    const k = pKey()
    if (k) {
      const newProject = reorderStore(projectPrompts())
      setProjectPrompts(newProject)
      saveToStorage(k, newProject)
    }
  }

  return (
    <SavedPromptsContext.Provider
      value={{
        prompts: allPrompts,
        globalPrompts,
        projectPrompts,
        hasProject: () => !!dir(),
        add,
        move,
        update,
        remove,
        reorder,
      }}
    >
      {props.children}
    </SavedPromptsContext.Provider>
  )
}

export function useSavedPrompts() {
  const ctx = useContext(SavedPromptsContext)
  if (!ctx) throw new Error("useSavedPrompts must be used within SavedPromptsProvider")
  return ctx
}
