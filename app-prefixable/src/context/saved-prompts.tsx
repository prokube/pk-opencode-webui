import { createContext, useContext, createSignal, createEffect, createMemo, on, type ParentProps, type Accessor } from "solid-js"
import { useBasePath } from "./base-path"
import { deriveDirectoryFromPathname } from "../utils/path"
import { readSavedPrompts, writeSavedPrompts, type StoredPrompt } from "../utils/extended-api"
import { useRecentProjects } from "./recent-projects"

export type PromptScope = "global" | "project"

export interface SavedPrompt {
  id: string
  title: string
  text: string
  createdAt: number
  scope: PromptScope
}

interface SavedPromptsContextValue {
  prompts: () => SavedPrompt[]
  globalPrompts: () => SavedPrompt[]
  projectPrompts: () => SavedPrompt[]
  canUseProjectScope: () => boolean
  hasActiveProject: () => boolean
  loading: () => boolean
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
const sortNewest = (a: SavedPrompt, b: SavedPrompt) => b.createdAt - a.createdAt

function parseStorage(raw: string | null, fallback: PromptScope): SavedPrompt[] {
  if (!raw) return []
  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed)) return []
  return parsed
    .filter(
      (p) =>
        p &&
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
      scope: p.scope === "project" ? "project" : fallback,
    }))
}

function readLegacyGlobal() {
  try {
    return parseStorage(localStorage.getItem(GLOBAL_KEY), "global")
  } catch {
    return []
  }
}

function readLegacyProject(directory: string | undefined) {
  if (!directory) return []
  try {
    return parseStorage(localStorage.getItem(projectKey(directory)), "project")
  } catch {
    return []
  }
}

function clearLegacy(directory: string | undefined) {
  try {
    localStorage.removeItem(GLOBAL_KEY)
  } catch {
    // noop
  }
  if (!directory) return
  try {
    localStorage.removeItem(projectKey(directory))
  } catch {
    // noop
  }
}

function mergePrompts(global: SavedPrompt[], project: SavedPrompt[]): SavedPrompt[] {
  const projectIds = new Set(project.map((p) => p.id))
  const dedupedGlobal = global.filter((p) => !projectIds.has(p.id))
  return [...dedupedGlobal, ...project].sort(sortNewest)
}

function isPrompt(p: SavedPrompt | undefined): p is SavedPrompt {
  return p !== undefined
}

function normalize(list: SavedPrompt[], scope: PromptScope): StoredPrompt[] {
  return list.map((p) => ({
    id: p.id,
    title: p.title,
    text: p.text,
    createdAt: p.createdAt,
    scope,
  }))
}

export function SavedPromptsProvider(props: ParentProps & { directory?: Accessor<string | undefined> }) {
  const basePath = useBasePath()
  const recent = useRecentProjects()

  const recentDirectory = createMemo(() => {
    const first = recent.projects()[0]
    if (!first?.path) return undefined
    const normalized = first.path.replace(/[\\/]+$/, "")
    return normalized || undefined
  })

  const [sticky, setSticky] = createSignal<string | undefined>(
    props.directory?.() ?? deriveDirectoryFromPathname(),
  )
  const [loading, setLoading] = createSignal(true)
  const [globalPrompts, setGlobalPrompts] = createSignal<SavedPrompt[]>([])
  const [projectPrompts, setProjectPrompts] = createSignal<SavedPrompt[]>([])
  const migratedKeys = new Set<string>()

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
  const targetDirectory = () => dir() ?? recentDirectory()

  const allPrompts = createMemo(() => mergePrompts(globalPrompts(), projectPrompts()))

  async function save(nextGlobal: SavedPrompt[], nextProject: SavedPrompt[]) {
    const d = targetDirectory()
    const ok = await writeSavedPrompts(
      basePath.serverUrl,
      d,
      normalize(nextGlobal, "global"),
      normalize(nextProject, "project"),
    )
    if (!ok) {
      console.error("[saved-prompts] failed to persist prompts")
      return
    }
    setGlobalPrompts(nextGlobal)
    setProjectPrompts(nextProject)
  }

  async function loadAndMaybeMigrate() {
    const d = targetDirectory()
    const migrationKey = d || "__global__"
    const data = await readSavedPrompts(basePath.serverUrl, d)
    let nextGlobal: SavedPrompt[] = (data.global ?? []).map((p) => ({ ...p, scope: "global" as const })).sort(sortNewest)
    let nextProject: SavedPrompt[] = (data.project ?? []).map((p) => ({ ...p, scope: "project" as const })).sort(sortNewest)

    if (!migratedKeys.has(migrationKey)) {
      const legacyGlobal = readLegacyGlobal().sort(sortNewest)
      const legacyProject = readLegacyProject(d).sort(sortNewest)
      const hasLegacy = legacyGlobal.length > 0 || legacyProject.length > 0
      const needsMigration = hasLegacy && nextGlobal.length === 0 && nextProject.length === 0
      if (!needsMigration) {
        migratedKeys.add(migrationKey)
      }
      if (needsMigration) {
        nextGlobal = legacyGlobal
        nextProject = legacyProject
        const ok = await writeSavedPrompts(
          basePath.serverUrl,
          d,
          normalize(nextGlobal, "global"),
          normalize(nextProject, "project"),
        )
        if (ok) {
          clearLegacy(d)
          migratedKeys.add(migrationKey)
        }
        if (!ok) {
          console.error("[saved-prompts] failed to migrate prompts from localStorage")
        }
      }
    }

    setGlobalPrompts(nextGlobal)
    setProjectPrompts(nextProject)
    setLoading(false)
  }

  createEffect(on(targetDirectory, () => {
    setLoading(true)
    loadAndMaybeMigrate()
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
      if (!targetDirectory()) {
        save([{ ...prompt, scope: "global" }, ...globalPrompts()], projectPrompts())
        return
      }
      save(globalPrompts(), [prompt, ...projectPrompts()])
      return
    }
    save([{ ...prompt, scope: "global" }, ...globalPrompts()], projectPrompts())
  }

  function move(id: string, scope: PromptScope) {
    const project = projectPrompts().find((p) => p.id === id)
    if (project) {
      if (scope === "project") return
      if (!targetDirectory()) return
      const nextProject = projectPrompts().filter((p) => p.id !== id)
      const nextGlobal = [{ ...project, scope: "global" as const }, ...globalPrompts().filter((p) => p.id !== id)]
      save(nextGlobal, nextProject)
      return
    }

    const global = globalPrompts().find((p) => p.id === id)
    if (!global) return
    if (scope === "global") return
    if (!targetDirectory()) return
    const nextGlobal = globalPrompts().filter((p) => p.id !== id)
    const nextProject = [{ ...global, scope: "project" as const }, ...projectPrompts().filter((p) => p.id !== id)]
    save(nextGlobal, nextProject)
  }

  function update(id: string, fields: Partial<Pick<SavedPrompt, "title" | "text">>) {
    if (projectPrompts().some((p) => p.id === id)) {
      if (!targetDirectory()) return
      const nextProject = projectPrompts().map((p) => (p.id === id ? { ...p, ...fields } : p))
      save(globalPrompts(), nextProject)
      return
    }
    const nextGlobal = globalPrompts().map((p) => (p.id === id ? { ...p, ...fields } : p))
    save(nextGlobal, projectPrompts())
  }

  function remove(id: string) {
    if (projectPrompts().some((p) => p.id === id)) {
      if (!targetDirectory()) return
      save(globalPrompts(), projectPrompts().filter((p) => p.id !== id))
      return
    }
    save(globalPrompts().filter((p) => p.id !== id), projectPrompts())
  }

  function reorder(ids: string[]) {
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

    save(reorderStore(globalPrompts()), reorderStore(projectPrompts()))
  }

  const hasActiveProject = () => {
    const active = props.directory?.() ?? deriveDirectoryFromPathname()
    return !!active
  }

  return (
    <SavedPromptsContext.Provider
      value={{
        prompts: allPrompts,
        globalPrompts,
        projectPrompts,
        canUseProjectScope: () => !!targetDirectory(),
        hasActiveProject,
        loading,
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
