import { Router, Route, useLocation, useNavigate, useParams } from "@solidjs/router"
import { createEffect, createMemo, ErrorBoundary, on, Show, type ParentProps } from "solid-js"
import { BasePathProvider, useBasePath } from "./context/base-path"
import { LOCAL_SERVER_ID, ServerProvider } from "./context/server"
import { BrandingProvider } from "./context/branding"
import { ThemeProvider } from "./context/theme"
import { CommandProvider } from "./context/command"
import { ProjectsProvider } from "./context/projects"
import { ProjectActivityProvider } from "./context/project-activity"
import { DirectoryLayout } from "./pages/directory-layout"
import { HomeLayout } from "./pages/home-layout"
import { Session } from "./pages/session"
import { Settings } from "./pages/settings"
import { ProjectPicker } from "./pages/project-picker"
import { base64Decode } from "./utils/path"
import { legacyStorageValue, workspaceStorageKey } from "./utils/storage"
import { BrowserNotificationsProvider } from "./context/browser-notifications"
import { ServerEventsProvider } from "./context/server-events"

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

function RecoveryBoundary(props: ParentProps & { session?: boolean; resetKey?: string }) {
  let resetBoundary: (() => void) | undefined
  createEffect(on(() => props.resetKey, () => resetBoundary?.(), { defer: true }))
  return (
    <ErrorBoundary fallback={(error, reset) => {
      resetBoundary = reset
      return (
        <div class="h-full flex items-center justify-center p-6" style={{ background: "var(--background-stronger)" }}>
          <div class="max-w-lg rounded-lg p-5 space-y-3" style={{ background: "var(--background-base)", border: "1px solid var(--border-base)" }}>
            <h1 class="font-medium" style={{ color: "var(--text-strong)" }}>
              {props.session ? "This session could not be displayed" : "The application encountered an error"}
            </h1>
            <p class="text-sm break-words" style={{ color: "var(--text-weak)" }}>
              {error instanceof Error ? error.message : String(error)}
            </p>
            <div class="flex gap-2">
              <button class="px-3 py-1.5 rounded text-sm" style={{ background: "var(--interactive-base)", color: "white" }} onClick={reset}>
                Try again
              </button>
              <button class="px-3 py-1.5 rounded text-sm" style={{ background: "var(--surface-inset)", color: "var(--text-base)" }} onClick={() => window.location.reload()}>
                Reload
              </button>
            </div>
          </div>
        </div>
      )
    }}>
      {props.children}
    </ErrorBoundary>
  )
}

function SessionRoute() {
  const params = useParams<{ dir: string; id?: string }>()
  const location = useLocation()
  const navigate = useNavigate()
  const fresh = createMemo(() => new URLSearchParams(location.search).has("new"))
  const href = createMemo(() => fresh() || params.id ? "session" : getLastSessionHref(params.dir))
  createEffect(() => {
    const next = href()
    if (next === "session") return
    navigate(next.replace(/^session\//, ""), { replace: true })
  })
  const key = createMemo(() => `${params.dir}:${params.id ?? location.search}`)
  return <Show when={href() === "session"}><RecoveryBoundary session resetKey={key()}><Session /></RecoveryBoundary></Show>
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
        <Route path="/session/:id?" component={SessionRoute} />
        <Route path="/settings" component={Settings} />
      </Route>
    </Router>
  )
}

function AppProviders() {
  return (
    <BasePathProvider>
      <ServerEventsProvider>
        <BrowserNotificationsProvider>
          <ThemeProvider>
            <BrandingProvider>
              <ProjectsProvider>
                <ProjectActivityProvider>
                  <CommandProvider>
                    <AppRoutes />
                  </CommandProvider>
                </ProjectActivityProvider>
              </ProjectsProvider>
            </BrandingProvider>
          </ThemeProvider>
        </BrowserNotificationsProvider>
      </ServerEventsProvider>
    </BasePathProvider>
  )
}

export function App() {
  return (
    <RecoveryBoundary>
      <ServerProvider>
        <AppProviders />
      </ServerProvider>
    </RecoveryBoundary>
  )
}
