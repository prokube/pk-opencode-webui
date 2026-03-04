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

function DirectoryIndex() {
  const params = useParams<{ dir: string }>()

  const target = (() => {
    if (typeof window === "undefined") return "session"
    try {
      const dir = base64Decode(params.dir)
      const last = window.localStorage.getItem(`opencode.lastSession.${dir}`)
      return last ? `session/${last}` : "session"
    } catch {
      return "session"
    }
  })()

  return <Navigate href={target} />
}

function SessionIndex() {
  const params = useParams<{ dir: string }>()

  const target = (() => {
    if (typeof window === "undefined") return null
    try {
      const dir = base64Decode(params.dir)
      const last = window.localStorage.getItem(`opencode.lastSession.${dir}`)
      return last ? last : null
    } catch {
      return null
    }
  })()

  if (!target) return <Session />
  return <Navigate href={target} />
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
