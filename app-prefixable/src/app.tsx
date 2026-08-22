import { Router, Route, useNavigate, useParams } from "@solidjs/router"
import { createEffect, createMemo, Show } from "solid-js"
import { BasePathProvider, useBasePath } from "./context/base-path"
import { LOCAL_SERVER_ID, ServerProvider } from "./context/server"
import { BrandingProvider } from "./context/branding"
import { ThemeProvider } from "./context/theme"
import { CommandProvider } from "./context/command"
import { ProjectsProvider } from "./context/projects"
import { DirectoryLayout } from "./pages/directory-layout"
import { HomeLayout } from "./pages/home-layout"
import { Session } from "./pages/session"
import { Settings } from "./pages/settings"
import { ProjectPicker } from "./pages/project-picker"
import { base64Decode } from "./utils/path"
import { legacyStorageValue, workspaceStorageKey } from "./utils/storage"

function validSessionId(value: string) {
  return !!value && !value.includes("..") && !/[/\\]/.test(value)
}

function getLastSessionHref(encodedDir: string): string {
  try {
    const dir = base64Decode(encodedDir)
    if (typeof window === "undefined") return "session"
    const key = workspaceStorageKey(LOCAL_SERVER_ID, dir, "lastSession")
    const current = window.localStorage.getItem(key)
    const legacy = [window.localStorage.getItem(`opencode.lastSession.${dir}`)]
    const result = legacyStorageValue(LOCAL_SERVER_ID, current, legacy, validSessionId)
    if (result.migrated && result.value) window.localStorage.setItem(key, result.value)
    const last = result.value
    if (!last || !validSessionId(last)) return "session"
    return `session/${last}`
  } catch {
    return "session"
  }
}

function DirectoryIndex() {
  const params = useParams<{ dir: string }>()
  const navigate = useNavigate()
  createEffect(() => navigate(getLastSessionHref(params.dir), { replace: true }))
  return null
}

function SessionIndex() {
  const params = useParams<{ dir: string }>()
  const navigate = useNavigate()
  const href = createMemo(() => getLastSessionHref(params.dir))
  createEffect(() => {
    const next = href()
    if (next === "session") return
    navigate(next.replace(/^session\//, ""), { replace: true })
  })
  return <Show when={href() === "session"}><Session /></Show>
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

function AppProviders() {
  return (
    <BasePathProvider>
      <ThemeProvider>
        <BrandingProvider>
          <ProjectsProvider>
            <CommandProvider>
              <AppRoutes />
            </CommandProvider>
          </ProjectsProvider>
        </BrandingProvider>
      </ThemeProvider>
    </BasePathProvider>
  )
}

export function App() {
  return (
    <ServerProvider>
      <AppProviders />
    </ServerProvider>
  )
}
