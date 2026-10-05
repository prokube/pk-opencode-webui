import { Router, Route, useLocation, useNavigate, useParams } from "@solidjs/router"
import {
  createEffect,
  createMemo,
  ErrorBoundary,
  on,
  onCleanup,
  Show,
  type ParentProps,
} from "solid-js"
import { BasePathProvider, useBasePath } from "./context/base-path"
import { LOCAL_SERVER_ID, ServerProvider, ServerScope, useConnections, useServer } from "./context/server"
import { useServerNavigate } from "./context/server-navigation"
import { serverHref } from "./utils/servers"
import { ServerManager } from "./components/server-manager"
import { ServerSelector } from "./components/server-selector"
import { ArrowLeft } from "lucide-solid"
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

function getLastSessionHref(encodedDir: string, serverId: string): string {
  try {
    const dir = base64Decode(encodedDir)
    if (typeof window === "undefined") return "session"
    const key = workspaceStorageKey(serverId, dir, "lastSession")
    const current = window.localStorage.getItem(key)
    const legacy = [window.localStorage.getItem(`opencode.lastSession.${dir}`)]
    const result = legacyStorageValue(serverId, current, legacy, validSessionId)
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
  const navigate = useServerNavigate()
  const server = useServer()
  createEffect(() => navigate(getLastSessionHref(params.dir, server.id), { replace: true }))
  return null
}

function RecoveryBoundary(
  props: ParentProps & { session?: boolean; resetKey?: string; onServerSettings?: () => void },
) {
  let resetBoundary: (() => void) | undefined
  createEffect(
    on(
      () => props.resetKey,
      () => resetBoundary?.(),
      { defer: true },
    ),
  )
  return (
    <ErrorBoundary
      fallback={(error, reset) => {
        resetBoundary = reset
        return (
          <div class="h-full flex items-center justify-center p-6" style={{ background: "var(--background-stronger)" }}>
            <div
              class="max-w-lg rounded-lg p-5 space-y-3"
              style={{ background: "var(--background-base)", border: "1px solid var(--border-base)" }}
            >
              <h1 class="font-medium" style={{ color: "var(--text-strong)" }}>
                {props.session ? "This session could not be displayed" : "The application encountered an error"}
              </h1>
              <p class="text-sm break-words" style={{ color: "var(--text-weak)" }}>
                {error instanceof Error ? error.message : String(error)}
              </p>
              <div class="flex gap-2">
                <button
                  class="px-3 py-1.5 rounded text-sm"
                  style={{ background: "var(--interactive-base)", color: "white" }}
                  onClick={reset}
                >
                  Try again
                </button>
                <button
                  class="px-3 py-1.5 rounded text-sm"
                  style={{ background: "var(--surface-inset)", color: "var(--text-base)" }}
                  onClick={() => window.location.reload()}
                >
                  Reload
                </button>
                <Show when={props.onServerSettings}>
                  <button class="px-3 py-1.5 rounded text-sm underline" onClick={props.onServerSettings}>
                    Server settings
                  </button>
                </Show>
              </div>
            </div>
          </div>
        )
      }}
    >
      {props.children}
    </ErrorBoundary>
  )
}

function SessionRoute() {
  const params = useParams<{ dir: string; id?: string }>()
  const location = useLocation()
  const navigate = useServerNavigate()
  const server = useServer()
  const fresh = createMemo(() => new URLSearchParams(location.search).has("new"))
  const href = createMemo(() => (fresh() || params.id ? "session" : getLastSessionHref(params.dir, server.id)))
  createEffect(() => {
    const next = href()
    if (next === "session") return
    navigate(next.replace(/^session\//, ""), { replace: true })
  })
  const key = createMemo(() => `${params.dir}:${params.id ?? location.search}`)
  return (
    <Show when={href() === "session"}>
      <RecoveryBoundary session resetKey={key()}>
        <Session />
      </RecoveryBoundary>
    </Show>
  )
}

function AppRoutes() {
  const { basePath } = useBasePath()
  const base = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath

  return (
    <Router base={base} root={ConnectionLayout}>
      <Route path="/settings/servers" component={ServerSettings} />
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

// Connection management must remain reachable without a working backend or
// stored credential. It uses only the browser's connection registry.
function ServerSettings() {
  const registry = useConnections()
  const navigate = useNavigate()
  const location = useLocation<{ workspace?: string }>()
  const id = () => new URLSearchParams(location.search).get("server") || LOCAL_SERVER_ID
  return (
    <main class="h-full overflow-y-auto p-6">
      <div class="mx-auto max-w-2xl space-y-6">
        <button type="button" class="flex items-center gap-2 text-sm" onClick={() => navigate(registry.workspace(id()) || serverHref(id(), "/"))}>
          <ArrowLeft size={16} />
          Back to workspace
        </button>
        <h1 class="text-xl font-medium">Settings</h1>
        <ServerSelector />
        <ServerManager />
      </div>
    </main>
  )
}

function ConnectionLayout(props: ParentProps) {
  const registry = useConnections()
  const { prefix } = useBasePath()
  const location = useLocation()
  const navigate = useNavigate()
  const id = () => new URLSearchParams(location.search).get("server") || LOCAL_SERVER_ID
  const connection = createMemo(() => registry.list().find((item) => item.id === id()))
  const serverSettings = () => location.pathname.replace(/\/$/, "") === prefix("/settings/servers")
  const openServerSettings = () => {
    if (serverSettings()) return
    const workspace = location.pathname.slice(prefix("/").length - 1) + location.search
    navigate(serverHref(id(), "/settings/servers"), { state: { workspace } })
  }
  const needsCredential = () => {
    const item = connection()
    return !!item && (item.auth === "basic" || item.auth === "bearer") && !registry.credentials()[item.id]
  }
  onCleanup(registry.followActive(() => (serverSettings() || needsCredential() ? undefined : connection()?.id)))
  createEffect(() => {
    if (!serverSettings() && !location.pathname.endsWith("/settings") && connection())
      registry.rememberWorkspace(id(), location.pathname.slice(prefix("/").length - 1) + location.search + location.hash)
    const path = location.pathname.slice(prefix("/").length - 1)
    const match = path.match(/^\/([^/]+)\/session(?:\/|$)/)
    if (connection() && match) registry.rememberProject(id(), base64Decode(match[1]), path + location.search + location.hash)
  })
  return (
    <div
      class="flex h-screen min-h-0 flex-col"
      style={{ background: "var(--background-stronger)", color: "var(--text-base)" }}
    >
      <div class="min-h-0 flex-1">
        <Show
          when={serverSettings()}
          fallback={
            <Show
              when={connection()}
              keyed
              fallback={
                <div class="p-8">
                  <p>This server connection is not configured in this browser.</p>
                  <ServerSelector />
                  <button type="button" class="mt-3 underline" onClick={openServerSettings}>
                    Server settings
                  </button>
                </div>
              }
            >
              {(item) => (
                <Show
                  when={!needsCredential()}
                  fallback={
                    <div class="p-8">
                      <p role="status">Authentication required for {item.name}.</p>
                      <ServerSelector />
                      <p>Enter credentials in Settings to open its sessions.</p>
                      <button type="button" class="mt-3 underline" onClick={openServerSettings}>
                        Server settings
                      </button>
                    </div>
                  }
                >
                  <RecoveryBoundary resetKey={item.id} onServerSettings={openServerSettings}>
                    <ServerScope connection={item}>
                      <AppProviders>{props.children}</AppProviders>
                    </ServerScope>
                  </RecoveryBoundary>
                </Show>
              )}
            </Show>
          }
        >
          {props.children}
        </Show>
      </div>
    </div>
  )
}

function AppProviders(props: ParentProps) {
  return (
    <ServerEventsProvider>
      <BrowserNotificationsProvider>
        <ProjectsProvider>
          <ProjectActivityProvider>
            <CommandProvider>{props.children}</CommandProvider>
          </ProjectActivityProvider>
        </ProjectsProvider>
      </BrowserNotificationsProvider>
    </ServerEventsProvider>
  )
}

export function App() {
  return (
    <RecoveryBoundary>
      <BasePathProvider>
        <ThemeProvider>
          <BrandingProvider>
            <ServerProvider>
              <AppRoutes />
            </ServerProvider>
          </BrandingProvider>
        </ThemeProvider>
      </BasePathProvider>
    </RecoveryBoundary>
  )
}
