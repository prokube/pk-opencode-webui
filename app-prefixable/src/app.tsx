import { Router, Route, Navigate, useParams } from "@solidjs/router"
import { createSignal, onMount, onCleanup, For } from "solid-js"
import { BasePathProvider, useBasePath } from "./context/base-path"
import { ServerProvider, useServer } from "./context/server"
import { BrandingProvider } from "./context/branding"
import { ThemeProvider } from "./context/theme"
import { CommandProvider } from "./context/command"
import { RecentProjectsProvider } from "./context/recent-projects"
import { SavedPromptsProvider } from "./context/saved-prompts"
import { GlobalEventsProvider } from "./context/global-events"
import { DirectoryLayout } from "./pages/directory-layout"
import { HomeLayout } from "./pages/home-layout"
import { Session } from "./pages/session"
import { Settings } from "./pages/settings"
import { ProjectPicker } from "./pages/project-picker"
import { base64Decode, deriveDirectoryFromPathname } from "./utils/path"
import type { Project } from "./components/shared"

const PROJECTS_STORAGE_KEY = "opencode.projects"

function getLastSessionHref(encodedDir: string): string {
  try {
    const dir = base64Decode(encodedDir)
    const last = typeof window !== "undefined"
      ? window.localStorage.getItem(`opencode.lastSession.${dir}`)
      : null
    if (!last || last.includes("..") || /[\/\\]/.test(last)) return "session"
    return `session/${last}`
  } catch {
    return "session"
  }
}

function DirectoryIndex() {
  const params = useParams<{ dir: string }>()
  return <Navigate href={getLastSessionHref(params.dir)} replace />
}

function SessionIndex() {
  const params = useParams<{ dir: string }>()
  const href = getLastSessionHref(params.dir)
  if (href === "session") return <Session />
  const id = href.replace(/^session\//, "")
  return <Navigate href={id} replace />
}

function AppRoutes() {
  const { basePath } = useBasePath()
  const base = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath

  return (
    <Router base={base}>
      {/* Root: Show project picker with sidebar */}
      <Route path="/" component={HomeLayout}>
        <Route path="/" component={ProjectPicker} />
        <Route path="/settings" component={Settings} />
      </Route>

      {/* Directory-scoped routes */}
      <Route path="/:dir" component={DirectoryLayout}>
        <Route path="/" component={DirectoryIndex} />
        <Route path="/session" component={SessionIndex} />
        <Route path="/session/:id" component={Session} />
        <Route path="/settings" component={Settings} />
      </Route>
    </Router>
  )
}

/**
 * Reads the active directory from window.location (outside Router context).
 * Re-evaluates on popstate and on history.pushState/history.replaceState navigation.
 */
function useActiveDirectory() {
  const [dir, setDir] = createSignal<string | undefined>(
    typeof window === "undefined" ? undefined : deriveDirectoryFromPathname(),
  )

  onMount(() => {
    // Ensure correct value once mounted (covers SSR hydration)
    setDir(deriveDirectoryFromPathname())

    function update() { setDir(deriveDirectoryFromPathname()) }

    // Patch pushState/replaceState to detect SolidJS Router navigations
    // instead of polling with setInterval
    const origPushState = history.pushState.bind(history)
    const origReplaceState = history.replaceState.bind(history)
    history.pushState = (...args) => { origPushState(...args); update() }
    history.replaceState = (...args) => { origReplaceState(...args); update() }
    window.addEventListener("popstate", update)

    onCleanup(() => {
      history.pushState = origPushState
      history.replaceState = origReplaceState
      window.removeEventListener("popstate", update)
    })
  })

  return dir
}

function useProjectsList() {
  const [projects, setProjects] = createSignal<Project[]>([])

  function load() {
    try {
      const stored = localStorage.getItem(PROJECTS_STORAGE_KEY)
      if (stored) {
        const parsed = JSON.parse(stored)
        setProjects(Array.isArray(parsed) ? parsed : [])
      } else {
        setProjects([])
      }
    } catch {
      setProjects([])
    }
  }

  onMount(() => {
    load()
    function onStorage(e: StorageEvent) {
      if (e.key === PROJECTS_STORAGE_KEY) load()
    }
    window.addEventListener("storage", onStorage)
    onCleanup(() => window.removeEventListener("storage", onStorage))
  })

  return projects
}

function AppWithServer(props: { projects: () => Project[]; activeDirectory: () => string | undefined }) {
  const { serverUrl, activeServerKey } = useServer()

  // Key by server config to force full remount when switching or editing servers
  return (
    <For each={[activeServerKey()]}>
      {() => (
        <BasePathProvider serverUrl={serverUrl()}>
          <ThemeProvider>
            <BrandingProvider>
              <RecentProjectsProvider>
                <SavedPromptsProvider directory={props.activeDirectory}>
                  <GlobalEventsProvider projects={props.projects} activeDirectory={props.activeDirectory}>
                    <CommandProvider>
                      <AppRoutes />
                    </CommandProvider>
                  </GlobalEventsProvider>
                </SavedPromptsProvider>
              </RecentProjectsProvider>
            </BrandingProvider>
          </ThemeProvider>
        </BasePathProvider>
      )}
    </For>
  )
}

export function App() {
  const projects = useProjectsList()
  const activeDirectory = useActiveDirectory()

  return (
    <ServerProvider>
      <AppWithServer projects={projects} activeDirectory={activeDirectory} />
    </ServerProvider>
  )
}
