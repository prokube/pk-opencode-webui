import { createSignal, Show, For, createMemo, onMount } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { base64Encode } from "../utils/path"
import { Folder, GitBranch } from "lucide-solid"
import { ProjectDialog } from "../components/project-dialog"
import { useBranding } from "../context/branding"
import { useBasePath } from "../context/base-path"
import { useRecentProjects } from "../context/recent-projects"
import { createOpencodeClient } from "../sdk/client"
import { Button } from "../components/ui/button"

// OpenCode Wordmark
function OpenCodeWordmark(props: { class?: string }) {
  return (
    <svg class={props.class} viewBox="0 0 640 115" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M49.2346 82.1433H16.4141V49.2861H49.2346V82.1433Z" fill="#CFCECD" />
      <path
        d="M49.2308 32.8573H16.4103V82.143H49.2308V32.8573ZM65.641 98.5716H0V16.4287H65.641V98.5716Z"
        fill="#656363"
      />
      <path d="M131.281 82.1433H98.4609V49.2861H131.281V82.1433Z" fill="#CFCECD" />
      <path
        d="M98.4649 82.143H131.285V32.8573H98.4649V82.143ZM147.696 98.5716H98.4649V115H82.0547V16.4287H147.696V98.5716Z"
        fill="#656363"
      />
      <path d="M229.746 65.7139V82.1424H180.516V65.7139H229.746Z" fill="#CFCECD" />
      <path
        d="M229.743 65.7144H180.512V82.143H229.743V98.5716H164.102V16.4287H229.743V65.7144ZM180.512 49.2859H213.332V32.8573H180.512V49.2859Z"
        fill="#656363"
      />
      <path d="M295.383 98.5718H262.562V49.2861H295.383V98.5718Z" fill="#CFCECD" />
      <path
        d="M295.387 32.8573H262.567V98.5716H246.156V16.4287H295.387V32.8573ZM311.797 98.5716H295.387V32.8573H311.797V98.5716Z"
        fill="#656363"
      />
      <path d="M393.848 82.1433H344.617V49.2861H393.848V82.1433Z" fill="#CFCECD" />
      <path d="M393.844 32.8573H344.613V82.143H393.844V98.5716H328.203V16.4287H393.844V32.8573Z" fill="#211E1E" />
      <path d="M459.485 82.1433H426.664V49.2861H459.485V82.1433Z" fill="#CFCECD" />
      <path
        d="M459.489 32.8573H426.668V82.143H459.489V32.8573ZM475.899 98.5716H410.258V16.4287H475.899V98.5716Z"
        fill="#211E1E"
      />
      <path d="M541.539 82.1433H508.719V49.2861H541.539V82.1433Z" fill="#CFCECD" />
      <path
        d="M541.535 32.8571H508.715V82.1428H541.535V32.8571ZM557.946 98.5714H492.305V16.4286H541.535V0H557.946V98.5714Z"
        fill="#211E1E"
      />
      <path d="M639.996 65.7139V82.1424H590.766V65.7139H639.996Z" fill="#CFCECD" />
      <path
        d="M590.77 32.8573V49.2859H623.59V32.8573H590.77ZM640 65.7144H590.77V82.143H640V98.5716H574.359V16.4287H640V65.7144Z"
        fill="#211E1E"
      />
    </svg>
  )
}

// Relative time formatting
function formatRelativeTime(timestamp: number): string {
  const now = Date.now()
  const diff = now - timestamp
  const seconds = Math.floor(diff / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (days > 0) return `${days}d ago`
  if (hours > 0) return `${hours}h ago`
  if (minutes > 0) return `${minutes}m ago`
  return "just now"
}

// Shorten path for display
function shortenPath(path: string, home: string): string {
  if (home && path.startsWith(home)) {
    return "~" + path.slice(home.length)
  }
  return path
}

/**
 * Project picker - Welcome screen with recent projects and actions.
 * Styled to match upstream OpenCode home page.
 */
export function ProjectPicker() {
  const navigate = useNavigate()
  const branding = useBranding()
  const { serverUrl } = useBasePath()
  const recent = useRecentProjects()
  const [dialogOpen, setDialogOpen] = createSignal(false)
  const [dialogView, setDialogView] = createSignal<"browse" | "clone">("browse")
  const [homeDir, setHomeDir] = createSignal("")

  // Get home directory for path shortening
  onMount(async () => {
    const client = createOpencodeClient({ baseUrl: serverUrl, throwOnError: false })
    const res = await client.path.get()
    if (res.data?.home) setHomeDir(res.data.home)
  })

  const recentProjects = createMemo(() => recent.projects().slice(0, 5))
  const hasRecent = createMemo(() => recentProjects().length > 0)

  function openDialog(view: "browse" | "clone") {
    setDialogView(view)
    setDialogOpen(true)
  }

  function handleProjectSelect(worktree: string) {
    recent.add(worktree)
    navigate(`/${base64Encode(worktree)}/session`)
  }

  function openRecentProject(path: string) {
    recent.add(path) // Updates lastOpened timestamp
    navigate(`/${base64Encode(path)}/session`)
  }

  return (
    <div class="mx-auto mt-40 w-full md:w-auto px-4 max-w-xl">
      {/* Logo */}
      <OpenCodeWordmark class="w-full md:w-xl opacity-12 mx-auto" />

      {/* Powered by branding - directly under logo */}
      <Show when={branding.enabled}>
        <div class="mt-4 flex items-center justify-center gap-2 text-sm" style={{ color: "var(--text-weak)" }}>
          <span>Powered by</span>
          <Show
            when={branding.url}
            fallback={
              <span class="font-medium" style={{ color: "var(--text-strong)" }}>
                {branding.name}
              </span>
            }
          >
            <a
              href={branding.url}
              target="_blank"
              rel="noopener noreferrer"
              class="font-medium transition-opacity hover:opacity-80"
              style={{ color: "var(--text-interactive-base)" }}
            >
              {branding.name}
            </a>
          </Show>
        </div>
      </Show>

      {/* Action buttons - stacked vertically */}
      <div class="mt-8 flex flex-col gap-2">
        <Button variant="ghost" size="large" class="justify-start px-3" onClick={() => openDialog("browse")}>
          <Folder class="w-5 h-5" />
          Open Project
        </Button>
        <Button variant="ghost" size="large" class="justify-start px-3" onClick={() => openDialog("clone")}>
          <GitBranch class="w-5 h-5" />
          Clone Repository
        </Button>
      </div>

      {/* Recent Projects */}
      <Show when={hasRecent()}>
        <div class="mt-12 flex flex-col gap-2">
          <div class="text-sm font-medium pl-3 mb-1" style={{ color: "var(--text-weak)" }}>
            Recent Projects
          </div>
          <For each={recentProjects()}>
            {(project) => (
              <Button
                variant="ghost"
                size="large"
                class="text-left justify-between px-3 font-mono text-sm"
                onClick={() => openRecentProject(project.path)}
              >
                <span class="truncate">{shortenPath(project.path, homeDir())}</span>
                <span class="text-sm font-sans" style={{ color: "var(--text-weak)" }}>
                  {formatRelativeTime(project.lastOpened)}
                </span>
              </Button>
            )}
          </For>
        </div>
      </Show>

      {/* Project Dialog */}
      <ProjectDialog
        open={dialogOpen()}
        onClose={() => setDialogOpen(false)}
        onSelect={handleProjectSelect}
        initialView={dialogView()}
      />
    </div>
  )
}
