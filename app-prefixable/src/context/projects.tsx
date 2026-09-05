import { createContext, createMemo, createSignal, onCleanup, type ParentProps, untrack, useContext } from "solid-js"
import { LOCAL_SERVER_ID } from "./server"
import { serverStorageKey } from "../utils/storage"

export interface Project {
  worktree: string
  name?: string
  lastOpened: number
}

interface ProjectStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

interface ProjectsContextValue {
  projects: () => Project[]
  recent: () => Project[]
  add: (worktree: string, name?: string) => void
  touch: (worktree: string, name?: string) => void
  remove: (worktree: string) => void
  clear: () => void
}

const LEGACY_PROJECTS_KEY = "opencode.projects"
const LEGACY_RECENT_KEY = "opencode-recent-projects"
const ProjectsContext = createContext<ProjectsContextValue>()

export function projectsStorageKey(serverId: string) {
  return serverStorageKey(serverId, "projects")
}

function normalize(worktree: string) {
  if (worktree === "/") return worktree
  return worktree.replace(/\/+$/, "")
}

function project(value: unknown): Project | undefined {
  if (!value || typeof value !== "object") return
  const candidate = value as Record<string, unknown>
  if (typeof candidate.worktree !== "string") return
  const worktree = normalize(candidate.worktree)
  if (!worktree) return
  if (candidate.name !== undefined && typeof candidate.name !== "string") return
  if (typeof candidate.lastOpened !== "number" || !Number.isFinite(candidate.lastOpened) || candidate.lastOpened < 0) return
  return {
    worktree,
    ...(candidate.name ? { name: candidate.name } : {}),
    lastOpened: candidate.lastOpened,
  }
}

export function parseProjects(value: string | null): Project[] {
  if (!value) return []
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    return mergeProjects(parsed.flatMap((item) => {
      const parsed = project(item)
      return parsed ? [parsed] : []
    }))
  } catch {
    return []
  }
}

export function mergeProjects(...lists: Project[][]): Project[] {
  const result: Project[] = []
  for (const item of lists.flat()) {
    const index = result.findIndex((existing) => existing.worktree === item.worktree)
    if (index === -1) {
      result.push(item)
      continue
    }
    const existing = result[index]
    result[index] = {
      worktree: existing.worktree,
      ...(existing.name || item.name ? { name: existing.name || item.name } : {}),
      lastOpened: Math.max(existing.lastOpened, item.lastOpened),
    }
  }
  return result
}

function parseLegacy(value: string | null, now: number): Project[] {
  if (!value) return []
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((item) => {
      if (!item || typeof item !== "object") return []
      const candidate = item as Record<string, unknown>
      const raw = typeof candidate.worktree === "string" ? candidate.worktree : candidate.path
      if (typeof raw !== "string") return []
      const worktree = normalize(raw)
      if (!worktree) return []
      if (candidate.name !== undefined && typeof candidate.name !== "string") return []
      if (candidate.lastOpened !== undefined && (
        typeof candidate.lastOpened !== "number" ||
        !Number.isFinite(candidate.lastOpened) ||
        candidate.lastOpened < 0
      )) return []
      const lastOpened = typeof candidate.lastOpened === "number" ? candidate.lastOpened : now
      return [{
        worktree,
        ...(candidate.name ? { name: candidate.name } : {}),
        lastOpened,
      }]
    })
  } catch {
    return []
  }
}

function read(storage: ProjectStorage, key: string) {
  try {
    return storage.getItem(key)
  } catch {
    return null
  }
}

export function loadProjects(storage: ProjectStorage, serverId: string, now = Date.now()): Project[] {
  const key = projectsStorageKey(serverId)
  const current = read(storage, key)
  if (current !== null) return parseProjects(current)
  if (serverId !== "local") return []

  const projects = mergeProjects(
    parseLegacy(read(storage, LEGACY_PROJECTS_KEY), now),
    parseLegacy(read(storage, LEGACY_RECENT_KEY), now),
  )
  try {
    storage.setItem(key, JSON.stringify(projects))
  } catch {
    return projects
  }
  for (const legacy of [LEGACY_PROJECTS_KEY, LEGACY_RECENT_KEY]) {
    try {
      storage.removeItem(legacy)
    } catch {
      // The new key is authoritative even when legacy cleanup is unavailable.
    }
  }
  return projects
}

export function ProjectsProvider(props: ParentProps) {
  const serverId = LOCAL_SERVER_ID
  const key = projectsStorageKey(serverId)
  const storage = typeof localStorage === "undefined" ? undefined : localStorage
  const [projects, setProjects] = createSignal<Project[]>(storage ? loadProjects(storage, serverId) : [])
  const recent = createMemo(() => [...projects()].sort((a, b) => b.lastOpened - a.lastOpened))

  function save(list: Project[]) {
    setProjects(list)
    if (!storage) return
    try {
      storage.setItem(key, JSON.stringify(list))
    } catch {
      // Keep in-memory project management available when storage is unavailable.
    }
  }

  function add(worktree: string, name?: string) {
    const normalized = normalize(worktree)
    const current = untrack(projects)
    if (!normalized || current.some((item) => item.worktree === normalized)) return
    save([...current, { worktree: normalized, ...(name ? { name } : {}), lastOpened: Date.now() }])
  }

  function touch(worktree: string, name?: string) {
    const normalized = normalize(worktree)
    if (!normalized) return
    const current = untrack(projects)
    const existing = current.find((item) => item.worktree === normalized)
    if (!existing) {
      save([...current, { worktree: normalized, ...(name ? { name } : {}), lastOpened: Date.now() }])
      return
    }
    save(current.map((item) => item.worktree === normalized
      ? { ...item, ...(name ? { name } : {}), lastOpened: Date.now() }
      : item))
  }

  function remove(worktree: string) {
    const normalized = normalize(worktree)
    save(untrack(projects).filter((item) => item.worktree !== normalized))
  }

  function clear() {
    save([])
  }

  if (typeof window !== "undefined") {
    const sync = (event: StorageEvent) => {
      if (event.key !== key) return
      setProjects(parseProjects(event.newValue))
    }
    window.addEventListener("storage", sync)
    onCleanup(() => window.removeEventListener("storage", sync))
  }

  return (
    <ProjectsContext.Provider value={{ projects, recent, add, touch, remove, clear }}>
      {props.children}
    </ProjectsContext.Provider>
  )
}

export function useProjects() {
  const context = useContext(ProjectsContext)
  if (!context) throw new Error("useProjects must be used within ProjectsProvider")
  return context
}
