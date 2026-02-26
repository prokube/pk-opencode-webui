import { createContext, useContext, createSignal, type ParentProps } from "solid-js"

interface RecentProject {
  path: string
  name: string
  lastOpened: number // timestamp
}

interface RecentProjectsContextValue {
  projects: () => RecentProject[]
  add: (path: string) => void
  remove: (path: string) => void
  clear: () => void
}

const STORAGE_KEY = "opencode-recent-projects"
const MAX_RECENT = 10

const RecentProjectsContext = createContext<RecentProjectsContextValue>()

function loadFromStorage(): RecentProject[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (!stored) return []
    const parsed = JSON.parse(stored)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (p): p is RecentProject =>
        typeof p.path === "string" && typeof p.name === "string" && typeof p.lastOpened === "number",
    )
  } catch {
    return []
  }
}

function saveToStorage(projects: RecentProject[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(projects))
  } catch {
    // Ignore storage errors
  }
}

function getProjectName(path: string): string {
  const trimmed = path.replace(/\/+$/, "")
  const lastSlash = trimmed.lastIndexOf("/")
  return lastSlash >= 0 ? trimmed.slice(lastSlash + 1) : trimmed
}

export function RecentProjectsProvider(props: ParentProps) {
  const [projects, setProjects] = createSignal<RecentProject[]>(loadFromStorage())

  function add(path: string) {
    const normalized = path.replace(/\/+$/, "")
    setProjects((prev) => {
      // Remove existing entry for this path
      const filtered = prev.filter((p) => p.path !== normalized)
      // Add to front with current timestamp
      const updated = [{ path: normalized, name: getProjectName(normalized), lastOpened: Date.now() }, ...filtered]
      // Limit to MAX_RECENT
      const limited = updated.slice(0, MAX_RECENT)
      saveToStorage(limited)
      return limited
    })
  }

  function remove(path: string) {
    const normalized = path.replace(/\/+$/, "")
    setProjects((prev) => {
      const filtered = prev.filter((p) => p.path !== normalized)
      saveToStorage(filtered)
      return filtered
    })
  }

  function clear() {
    setProjects([])
    saveToStorage([])
  }

  return (
    <RecentProjectsContext.Provider value={{ projects, add, remove, clear }}>
      {props.children}
    </RecentProjectsContext.Provider>
  )
}

export function useRecentProjects() {
  const ctx = useContext(RecentProjectsContext)
  if (!ctx) throw new Error("useRecentProjects must be used within RecentProjectsProvider")
  return ctx
}
