import { Router, Route, useLocation, useNavigate, useParams } from "@solidjs/router"
import {
  createEffect,
  createMemo,
  createSignal,
  ErrorBoundary,
  For,
  on,
  onCleanup,
  Show,
  type ParentProps,
} from "solid-js"
import { BasePathProvider, useBasePath } from "./context/base-path"
import { LOCAL_SERVER_ID, ServerProvider, ServerScope, useConnections, useServer } from "./context/server"
import { useServerNavigate } from "./context/server-navigation"
import { serverHref, tabHref, tabKey } from "./utils/servers"
import { ServerManager } from "./components/server-manager"
import { ChevronDown, Plus, X } from "lucide-solid"
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
import { base64Decode, base64Encode, deriveDirectoryFromPathname } from "./utils/path"
import { createOpencodeClient } from "./sdk/client"
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

function RecoveryBoundary(props: ParentProps & { session?: boolean; resetKey?: string }) {
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

function ConnectionLayout(props: ParentProps) {
  const registry = useConnections()
  const location = useLocation()
  const navigate = useNavigate()
  const id = () => new URLSearchParams(location.search).get("server") || LOCAL_SERVER_ID
  const connection = createMemo(() => registry.list().find((item) => item.id === id()))
  const needsCredential = () => {
    const item = connection()
    return !!item && item.auth !== "none" && !registry.credentials()[item.id]
  }
  onCleanup(registry.followActive(() => (needsCredential() ? undefined : connection()?.id)))
  const health = createMemo(() => {
    const item = connection()
    return item && !needsCredential() ? registry.events(item) : undefined
  })
  const [manager, setManager] = createSignal(false)
  const [starting, setStarting] = createSignal(false)
  const [startError, setStartError] = createSignal("")
  const selected = (tab: ReturnType<typeof registry.tabs>[number]) =>
    tab.server === id() &&
    (tab.draftID
      ? location.pathname.endsWith(`/${base64Encode(tab.directory)}/session`) &&
        (new URLSearchParams(location.search).get("new") || base64Encode(tab.directory)) === tab.draftID
      : location.pathname.endsWith(`/session/${tab.sessionId}`))
  async function newSession() {
    const item = connection()
    if (!item) return
    setStarting(true)
    setStartError("")
    try {
      const target = registry.transport(item)
      const client = createOpencodeClient({
        baseUrl: target.serverUrl(),
        headers: target.authHeaders(),
        throwOnError: true,
      })
      const directory = deriveDirectoryFromPathname() || (await client.path.get()).data?.directory
      if (id() !== item.id) return
      if (!directory) throw new Error("Select a project before starting a session")
      navigate(serverHref(item.id, `/${base64Encode(directory)}/session?new=${crypto.randomUUID()}`))
    } catch {
      if (id() === item.id) setStartError("Could not open a new session. Check the server connection.")
    } finally {
      setStarting(false)
    }
  }
  return (
    <div
      class="flex h-screen min-h-0 flex-col"
      style={{ background: "var(--background-stronger)", color: "var(--text-base)" }}
    >
      <header
        class="flex shrink-0 items-center gap-2 border-b px-3 h-10"
        style={{ "border-color": "var(--border-base)" }}
      >
        <button
          type="button"
          class="flex items-center gap-2 rounded px-2 py-1 text-sm"
          aria-label="Select server"
          onClick={() => setManager(true)}
        >
          {connection()?.name || "Server unavailable"}
          <ChevronDown size={14} />
        </button>
        <span class="text-xs" role="status" style={{ color: "var(--text-weak)" }}>
          {!connection()
            ? "Not connected"
            : needsCredential()
              ? "Authentication required"
              : health()?.connected()
                ? "Connected"
                : health()?.unhealthy()
                  ? "Reconnecting…"
                  : "Connecting…"}
        </span>
        <Show when={startError()}>
          <span role="alert" class="text-xs">
            {startError()}
          </span>
        </Show>
        <button
          type="button"
          class="ml-auto flex items-center gap-1 text-xs"
          disabled={starting() || !connection() || needsCredential()}
          onClick={() => void newSession()}
        >
          <Plus size={14} />
          New session
        </button>
      </header>
      <Show when={registry.tabs().length}>
        <nav
          aria-label="Open sessions"
          class="flex shrink-0 overflow-x-auto border-b"
          style={{ "border-color": "var(--border-base)" }}
        >
          <For each={registry.tabs()}>
            {(tab) => (
              <div
                class="flex min-w-0 shrink-0 items-center gap-1 border-r px-2"
                style={{
                  background: selected(tab) ? "var(--background-base)" : "transparent",
                  "border-color": "var(--border-base)",
                }}
              >
                <button
                  type="button"
                  class="max-w-56 truncate py-2 text-sm"
                  aria-current={selected(tab) ? "page" : undefined}
                  onClick={() => navigate(tabHref(tab))}
                >
                  <span class="mr-2 text-xs" style={{ color: "var(--text-weak)" }}>
                    {registry.list().find((server) => server.id === tab.server)?.name}
                  </span>
                  <Show when={registry.busy()[tabKey(tab)]}>
                    <span aria-label="Running" class="mr-1" style={{ color: "var(--text-interactive-base)" }}>
                      ●
                    </span>
                  </Show>
                  {tab.title}
                </button>
                <button
                  type="button"
                  aria-label={`Close ${tab.title}`}
                  class="p-1"
                  onClick={() => {
                    const active = selected(tab)
                    const index = registry.tabs().findIndex((item) => tabKey(item) === tabKey(tab))
                    registry.close(tab)
                    if (active) {
                      const next = registry.tabs()[Math.max(0, index - 1)]
                      navigate(next ? tabHref(next) : serverHref(id(), "/"))
                    }
                  }}
                >
                  <X size={12} />
                </button>
              </div>
            )}
          </For>
        </nav>
      </Show>
      <Show when={manager()}>
        <ServerManager open onClose={() => setManager(false)} onSelect={(key) => navigate(serverHref(key, "/"))} />
      </Show>
      <div class="min-h-0 flex-1">
        <Show
          when={connection()}
          keyed
          fallback={
            <div class="p-8">
              <p>This server connection is not configured in this browser.</p>
              <button type="button" class="mt-3 underline" onClick={() => setManager(true)}>
                Manage servers
              </button>
            </div>
          }
        >
          {(item) => (
            <Show
              when={!needsCredential()}
              fallback={
                <div class="p-8">
                  <p>Enter credentials for {item.name} to open its sessions.</p>
                  <button type="button" class="mt-3 underline" onClick={() => setManager(true)}>
                    Edit server connection
                  </button>
                </div>
              }
            >
              <RecoveryBoundary resetKey={item.id}>
                <ServerScope connection={item}>
                  <AppProviders>{props.children}</AppProviders>
                </ServerScope>
              </RecoveryBoundary>
            </Show>
          )}
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
