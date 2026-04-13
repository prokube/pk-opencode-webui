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
  error: () => string | undefined
  add: (title: string, text: string, scope?: PromptScope) => void
  move: (id: string, scope: PromptScope) => void
  update: (id: string, fields: Partial<Pick<SavedPrompt, "title" | "text">>) => void
  remove: (id: string) => void
  reorder: (ids: string[]) => void
}

const GLOBAL_KEY = "opencode.savedPrompts"

function canonicalDirectory(directory: string | undefined): string | undefined {
  if (!directory) return undefined
  const trimmed = directory.trim()
  if (!trimmed) return undefined
  if (trimmed === "/" || trimmed === "\\") return trimmed
  const drive = trimmed.match(/^([A-Za-z]:)(?:[\\/])?$/)
  if (drive) return `${drive[1]}\\`
  const unc = trimmed.match(/^[\\/]{2}([^\\/]+)[\\/]([^\\/]+)(?:[\\/])?$/)
  if (unc) return `\\\\${unc[1]}\\${unc[2]}\\`
  const normalized = trimmed.replace(/[\\/]+$/, "")
  if (!normalized) return trimmed[0] === "\\" ? "\\" : "/"
  return normalized
}

function projectKey(directory: string): string {
  const normalized = canonicalDirectory(directory)
  return `opencode.savedPrompts.${normalized || directory}`
}

const SavedPromptsContext = createContext<SavedPromptsContextValue>()
const sortNewest = (a: SavedPrompt, b: SavedPrompt) => b.createdAt - a.createdAt

function parseStorage(raw: string | null, sourceScope: PromptScope): SavedPrompt[] {
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
      scope: sourceScope,
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

function mergeUnique(primary: SavedPrompt[], secondary: SavedPrompt[]): SavedPrompt[] {
  const byId = new Set(primary.map((p) => p.id))
  const merged = [...primary]
  for (const p of secondary) {
    if (byId.has(p.id)) continue
    merged.push(p)
  }
  return merged.sort(sortNewest)
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
    return canonicalDirectory(first.path)
  })

  const [sticky, setSticky] = createSignal<string | undefined>(
    canonicalDirectory(props.directory?.() ?? deriveDirectoryFromPathname()),
  )
  const [loading, setLoading] = createSignal(true)
  const [loadError, setLoadError] = createSignal<string | undefined>()
  const [globalPrompts, setGlobalPrompts] = createSignal<SavedPrompt[]>([])
  const [projectPrompts, setProjectPrompts] = createSignal<SavedPrompt[]>([])
  const migratedKeys = new Set<string>()
  let loadVersion = 0
  let saveQueue = Promise.resolve()
  const pendingSaves: Array<{
    directory: string | undefined
    updater: (state: { global: SavedPrompt[]; project: SavedPrompt[] }) => { global: SavedPrompt[]; project: SavedPrompt[] }
  }> = []

  let pendingClear = false

  createEffect(() => {
    const d = canonicalDirectory(props.directory?.())
    if (d) {
      pendingClear = false
      setSticky(d)
      return
    }
    const fromUrl = canonicalDirectory(deriveDirectoryFromPathname())
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
        if (canonicalDirectory(deriveDirectoryFromPathname()) !== undefined) return
        setSticky(undefined)
      })
    }
  })

  const dir = sticky
  const targetDirectory = () => canonicalDirectory(dir() ?? recentDirectory())

  const allPrompts = createMemo(() => mergePrompts(globalPrompts(), projectPrompts()))

  function enqueueSave(
    version: number,
    directory: string | undefined,
    updater: (state: { global: SavedPrompt[]; project: SavedPrompt[] }) => { global: SavedPrompt[]; project: SavedPrompt[] },
  ) {
    saveQueue = saveQueue.catch(() => undefined).then(async () => {
      if (version !== loadVersion) return
      if (directory !== targetDirectory()) return
      const next = updater({ global: globalPrompts(), project: projectPrompts() })
      const ok = await writeSavedPrompts(
        basePath.serverUrl,
        directory,
        normalize(next.global, "global"),
        normalize(next.project, "project"),
      )
      if (!ok) {
        console.error("[saved-prompts] failed to persist prompts")
        return
      }
      if (version !== loadVersion) return
      if (directory !== targetDirectory()) return
      setGlobalPrompts(next.global)
      setProjectPrompts(next.project)
    })
  }

  function save(updater: (state: { global: SavedPrompt[]; project: SavedPrompt[] }) => { global: SavedPrompt[]; project: SavedPrompt[] }) {
    const directory = targetDirectory()
    if (loading()) {
      pendingSaves.push({ directory, updater })
      return
    }
    if (loadError()) {
      console.warn("[saved-prompts] skipped save because prompt load failed")
      return
    }
    enqueueSave(loadVersion, directory, updater)
  }

  async function loadAndMaybeMigrate(version: number) {
    const d = targetDirectory()
    const migrationKey = d || "__global__"
    try {
      const data = await readSavedPrompts(basePath.serverUrl, d)
      if (version !== loadVersion) return
      let nextGlobal: SavedPrompt[] = (data.global ?? []).map((p) => ({ ...p, scope: "global" as const })).sort(sortNewest)
      let nextProject: SavedPrompt[] = (data.project ?? []).map((p) => ({ ...p, scope: "project" as const })).sort(sortNewest)

      if (!migratedKeys.has(migrationKey)) {
        const legacyGlobal = readLegacyGlobal().sort(sortNewest)
        const legacyProject = readLegacyProject(d).sort(sortNewest)
        const hasLegacy = legacyGlobal.length > 0 || legacyProject.length > 0
        if (hasLegacy) {
          const mergedGlobal = mergeUnique(nextGlobal, legacyGlobal)
          const mergedProject = mergeUnique(nextProject, legacyProject)
          const changed = mergedGlobal.length !== nextGlobal.length || mergedProject.length !== nextProject.length
          nextGlobal = mergedGlobal
          nextProject = mergedProject
          const ok = await writeSavedPrompts(
            basePath.serverUrl,
            d,
            normalize(nextGlobal, "global"),
            normalize(nextProject, "project"),
          )
          if (version !== loadVersion) return
          if (ok) {
            clearLegacy(d)
            migratedKeys.add(migrationKey)
          }
          if (!ok) {
            console.error("[saved-prompts] failed to migrate prompts from localStorage")
            if (changed) {
              nextGlobal = (data.global ?? []).map((p) => ({ ...p, scope: "global" as const })).sort(sortNewest)
              nextProject = (data.project ?? []).map((p) => ({ ...p, scope: "project" as const })).sort(sortNewest)
            }
          }
        }
        if (!hasLegacy) {
          migratedKeys.add(migrationKey)
        }
      }

      setGlobalPrompts(nextGlobal)
      setProjectPrompts(nextProject)
      setLoadError(undefined)
    } catch (e) {
      console.error("[saved-prompts] failed to load prompts", e)
      if (version !== loadVersion) return
      setGlobalPrompts([])
      setProjectPrompts([])
      pendingSaves.splice(0, pendingSaves.length)
      const msg = e instanceof Error && e.message ? e.message : "unknown error"
      setLoadError(`Failed to load saved prompts: ${msg}`)
    } finally {
      if (version !== loadVersion) return
      setLoading(false)
    }
  }

  createEffect(on(targetDirectory, () => {
    const version = ++loadVersion
    pendingSaves.splice(0, pendingSaves.length)
    setLoading(true)
    setLoadError(undefined)
    setGlobalPrompts([])
    setProjectPrompts([])
    loadAndMaybeMigrate(version)
  }))

  createEffect(() => {
    if (loading()) return
    if (loadError()) {
      pendingSaves.splice(0, pendingSaves.length)
      return
    }
    if (pendingSaves.length === 0) return
    const queued = pendingSaves.splice(0, pendingSaves.length)
    const version = loadVersion
    for (const item of queued) {
      enqueueSave(version, item.directory, item.updater)
    }
  })

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
        save((state) => ({ global: [{ ...prompt, scope: "global" }, ...state.global], project: state.project }))
        return
      }
      save((state) => ({ global: state.global, project: [prompt, ...state.project] }))
      return
    }
    save((state) => ({ global: [{ ...prompt, scope: "global" }, ...state.global], project: state.project }))
  }

  function move(id: string, scope: PromptScope) {
    const project = projectPrompts().find((p) => p.id === id)
    if (project) {
      if (scope === "project") return
      if (!targetDirectory()) return
      save((state) => ({
        global: [{ ...project, scope: "global" as const }, ...state.global.filter((p) => p.id !== id)],
        project: state.project.filter((p) => p.id !== id),
      }))
      return
    }

    const global = globalPrompts().find((p) => p.id === id)
    if (!global) return
    if (scope === "global") return
    if (!targetDirectory()) return
    save((state) => ({
      global: state.global.filter((p) => p.id !== id),
      project: [{ ...global, scope: "project" as const }, ...state.project.filter((p) => p.id !== id)],
    }))
  }

  function update(id: string, fields: Partial<Pick<SavedPrompt, "title" | "text">>) {
    if (projectPrompts().some((p) => p.id === id)) {
      if (!targetDirectory()) return
      save((state) => ({
        global: state.global,
        project: state.project.map((p) => (p.id === id ? { ...p, ...fields } : p)),
      }))
      return
    }
    save((state) => ({
      global: state.global.map((p) => (p.id === id ? { ...p, ...fields } : p)),
      project: state.project,
    }))
  }

  function remove(id: string) {
    if (projectPrompts().some((p) => p.id === id)) {
      if (!targetDirectory()) return
      save((state) => ({ global: state.global, project: state.project.filter((p) => p.id !== id) }))
      return
    }
    save((state) => ({ global: state.global.filter((p) => p.id !== id), project: state.project }))
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

    save((state) => ({
      global: reorderStore(state.global),
      project: reorderStore(state.project),
    }))
  }

  const hasActiveProject = () => {
    const active = canonicalDirectory(props.directory?.() ?? deriveDirectoryFromPathname())
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
        error: loadError,
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
