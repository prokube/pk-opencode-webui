import { Router, Route, Navigate, useParams } from "@solidjs/router"
import { BasePathProvider, useBasePath } from "./context/base-path"
import { BrandingProvider } from "./context/branding"
import { CommandProvider } from "./context/command"
import { RecentProjectsProvider } from "./context/recent-projects"
import { DirectoryLayout } from "./pages/directory-layout"
import { HomeLayout } from "./pages/home-layout"
import { Session } from "./pages/session"
import { Settings } from "./pages/settings"
import { ProjectPicker } from "./pages/project-picker"
import { base64Decode } from "./utils/path"

function getLastSessionHref(encodedDir: string): string {
  try {
    const dir = base64Decode(encodedDir)
    const last = typeof window !== "undefined"
      ? window.localStorage.getItem(`opencode.lastSession.${dir}`)
      : null
    return last ? `session/${last}` : "session"
  } catch {
    return "session"
  }
}

function DirectoryIndex() {
  const params = useParams<{ dir: string }>()
  return <Navigate href={getLastSessionHref(params.dir)} />
}

function SessionIndex() {
  const params = useParams<{ dir: string }>()
  const last = (() => {
    try {
      const dir = base64Decode(params.dir)
      return typeof window !== "undefined"
        ? window.localStorage.getItem(`opencode.lastSession.${dir}`)
        : null
    } catch {
      return null
    }
  })()
  return last ? <Navigate href={`session/${last}`} /> : <Session />
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

export function App() {
  return (
    <BasePathProvider>
      <BrandingProvider>
        <RecentProjectsProvider>
          <CommandProvider>
            <AppRoutes />
          </CommandProvider>
        </RecentProjectsProvider>
      </BrandingProvider>
    </BasePathProvider>
  )
}
