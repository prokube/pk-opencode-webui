import { createSignal, For, Show, onMount, createEffect, createMemo } from "solid-js"
import { createOpencodeClient, type Event } from "../sdk/client"
import { useBasePath } from "../context/base-path"
import { Spinner } from "./ui/spinner"
import { Button } from "./ui/button"
import { Folder, X, GitBranch, AlertCircle } from "lucide-solid"
import { Terminal } from "./terminal"
import { useEvents } from "../context/events"
import { mkdir, listDirs } from "../utils/extended-api"
import fuzzysort from "fuzzysort"

type DialogView = "browse" | "clone"

interface ProjectDialogProps {
  open: boolean
  onClose: () => void
  onSelect: (worktree: string) => void
  initialView?: DialogView
}

// Path utility functions
function normalizePath(input: string) {
  const v = input.replaceAll("\\", "/")
  return v.replace(/\/+/g, "/")
}

function trimTrailing(input: string) {
  const v = normalizePath(input)
  if (v === "/") return v
  return v.replace(/\/+$/, "")
}

function getFilename(path: string) {
  const p = trimTrailing(path)
  const i = p.lastIndexOf("/")
  return i < 0 ? p : p.slice(i + 1)
}

function getDirectory(path: string) {
  const p = trimTrailing(path)
  const i = p.lastIndexOf("/")
  if (i < 0) return ""
  return p.slice(0, i + 1)
}

function tildeOf(absolute: string, home: string) {
  const full = trimTrailing(absolute)
  if (!home) return ""
  const hn = trimTrailing(home)
  if (full === hn) return "~"
  if (full.startsWith(hn + "/")) return "~" + full.slice(hn.length)
  return ""
}

function displayPath(path: string, home: string) {
  const full = trimTrailing(path)
  return tildeOf(full, home) || full
}

export function ProjectDialog(props: ProjectDialogProps) {
  const { serverUrl } = useBasePath()
  const events = useEvents()

  const [homeDirectory, setHomeDirectory] = createSignal<string | null>(null)
  const [filter, setFilter] = createSignal("")
  const [results, setResults] = createSignal<string[]>([])
  const [loading, setLoading] = createSignal(false)
  const [selectedIndex, setSelectedIndex] = createSignal(0)
  const [newFolderName, setNewFolderName] = createSignal("")
  const [creating, setCreating] = createSignal(false)

  // Git clone state
  const [showCloneForm, setShowCloneForm] = createSignal(false)
  const [repoUrl, setRepoUrl] = createSignal("")
  const [cloning, setCloning] = createSignal(false)
  const [cloneError, setCloneError] = createSignal<string | null>(null)
  const [clonePtyId, setClonePtyId] = createSignal<string | null>(null)
  const [cloneSuccess, setCloneSuccess] = createSignal(false)
  const [cloneTargetPath, setCloneTargetPath] = createSignal<string | null>(null)

  // Cache for directory listings
  const dirCache = new Map<string, string[]>()
  let searchToken = 0
  let inputRef: HTMLInputElement | undefined
  let cloneUnsubscribe: (() => void) | null = null

  const client = createOpencodeClient({ baseUrl: serverUrl, throwOnError: false })
  const global = createOpencodeClient({ baseUrl: serverUrl, throwOnError: false })

  // Load home directory on mount
  onMount(async () => {
    try {
      const res = await client.path.get()
      if (res.data?.home) {
        setHomeDirectory(res.data.home)
      }
    } catch (e) {
      console.error("Failed to fetch path info:", e)
    }
  })

  // Reset state when dialog closes
  createEffect(() => {
    if (!props.open) {
      setFilter("")
      setResults([])
      setSelectedIndex(0)
      setNewFolderName("")
      setShowCloneForm(false)
      setClonePtyId(null)
      setCloneError(null)
      setCloneSuccess(false)
      setRepoUrl("")
      setCloneTargetPath(null)
      dirCache.clear()
      // Cleanup PTY event subscription
      if (cloneUnsubscribe) {
        cloneUnsubscribe()
        cloneUnsubscribe = null
      }
    }
  })

  // Set initial view when dialog opens
  createEffect(() => {
    if (props.open) {
      setShowCloneForm(props.initialView === "clone")
      // Focus input when dialog opens
      setTimeout(() => inputRef?.focus(), 50)
    }
  })

  // Search directories when filter changes
  createEffect(() => {
    const value = filter()
    const home = homeDirectory()
    if (!props.open || !home) return
    searchDirectories(value, home)
  })

  async function getDirs(directory: string): Promise<string[]> {
    const key = trimTrailing(directory)
    const cached = dirCache.get(key)
    if (cached) return cached

    try {
      const dirs = await listDirs(serverUrl, key, { limit: 500, depth: 1 })
      // Convert to absolute paths
      const absolute = dirs.map(d => `${key}/${d.replace(/\/$/, "")}`.replace(/\/+/g, "/"))
      dirCache.set(key, absolute)
      return absolute
    } catch {
      return []
    }
  }

  async function searchDirectories(value: string, home: string) {
    const token = ++searchToken
    const isActive = () => token === searchToken

    setLoading(true)
    const input = value.trim()
    const endsWithSlash = input.endsWith("/")
    
    try {
      // Determine base directory and query
      let baseDir = home
      let query = input

      if (input.startsWith("~/")) {
        baseDir = home
        query = input.slice(2)
      } else if (input === "~") {
        baseDir = home
        query = ""
      }

      // Split query into path segments (keep empty string if ends with /)
      const rawSegments = query.split("/")
      // If ends with /, all segments are "head" (directories to navigate into)
      // If not, last segment is "tail" (partial match)
      const head = endsWithSlash 
        ? rawSegments.filter(Boolean)
        : rawSegments.slice(0, -1).filter(Boolean)
      const tail = endsWithSlash ? "" : (rawSegments[rawSegments.length - 1] || "")
      
      // Navigate through head segments
      let currentDir = baseDir
      for (const segment of head) {
        if (!isActive()) return
        const dirs = await getDirs(currentDir)
        
        // Find matching directory (exact match first, then fuzzy)
        const exactMatch = dirs.find(d => getFilename(d).toLowerCase() === segment.toLowerCase())
        if (exactMatch) {
          currentDir = exactMatch
        } else {
          const fuzzyMatch = fuzzysort.go(segment, dirs.map(d => ({ path: d, name: getFilename(d) })), { key: "name", limit: 1 })[0]
          if (fuzzyMatch) {
            currentDir = fuzzyMatch.obj.path
          } else {
            setResults([])
            setLoading(false)
            return
          }
        }
      }

      if (!isActive()) return

      // Get directories in current location
      const dirs = await getDirs(currentDir)
      if (!isActive()) return

      let filtered: string[]
      
      if (tail) {
        // Fuzzy match on tail segment
        const items = dirs.map(d => ({ path: d, name: getFilename(d) }))
        const matches = fuzzysort.go(tail, items, { key: "name", limit: 50 })
        filtered = matches.map(m => m.obj.path)
        
        // If there's an exact match for tail, also show its children (like shell completion)
        const exactMatch = dirs.find(d => getFilename(d).toLowerCase() === tail.toLowerCase())
        if (exactMatch && !endsWithSlash) {
          const children = await getDirs(exactMatch)
          if (isActive()) {
            filtered = Array.from(new Set([...filtered, ...children.slice(0, 30)]))
          }
        }
      } else {
        filtered = dirs.slice(0, 50)
      }

      // If input ends with /, show current directory as first selectable option
      if (endsWithSlash && currentDir !== home) {
        filtered = [currentDir, ...filtered.filter(d => d !== currentDir)]
      }

      // Always include home at the start if searching from ~
      if ((input === "" || input === "~") && !filtered.includes(home)) {
        filtered = [home, ...filtered]
      }

      setResults(filtered)
      setSelectedIndex(0)
    } catch (e) {
      console.error("Search error:", e)
      setResults([])
    } finally {
      setLoading(false)
    }
  }

  function selectProject(path: string) {
    props.onSelect(path)
    props.onClose()
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault()
      if (showCloneForm()) {
        setShowCloneForm(false)
      } else {
        props.onClose()
      }
    }
  }

  function handleInputKeyDown(e: KeyboardEvent) {
    const items = results()
    
    if (e.key === "ArrowDown") {
      e.preventDefault()
      if (items.length === 0) return
      setSelectedIndex(Math.min(selectedIndex() + 1, items.length - 1))
      scrollToSelected()
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      if (items.length === 0) return
      setSelectedIndex(Math.max(selectedIndex() - 1, 0))
      scrollToSelected()
    } else if (e.key === "Enter") {
      e.preventDefault()
      const selected = items[selectedIndex()]
      if (selected) {
        selectProject(selected)
      }
    } else if (e.key === "Tab" && !e.shiftKey) {
      e.preventDefault()
      // Tab completion - set path with trailing / to show contents
      const selected = items[selectedIndex()]
      if (selected) {
        const home = homeDirectory()
        const display = home ? displayPath(selected, home) : selected
        setFilter(display.endsWith("/") ? display : display + "/")
      }
    }
  }

  function scrollToSelected() {
    setTimeout(() => {
      document.querySelector(`[data-result-index="${selectedIndex()}"]`)?.scrollIntoView({ block: "nearest" })
    }, 0)
  }

  async function createFolder() {
    const home = homeDirectory()
    const name = newFolderName().trim()
    if (!name || !home || creating()) return

    // Determine base directory from current filter
    let baseDir = home
    const input = filter().trim()
    if (input.startsWith("~/")) {
      const path = input.slice(2)
      const segments = path.split("/").filter(Boolean)
      if (segments.length > 0) {
        baseDir = `${home}/${segments.join("/")}`
      }
    } else if (input.startsWith("/")) {
      baseDir = input
    }

    const fullPath = `${trimTrailing(baseDir)}/${name}`.replace(/\/+/g, "/")

    setCreating(true)
    try {
      const success = await mkdir(serverUrl, fullPath)
      if (success) {
        // Clear cache and select the new folder
        dirCache.clear()
        selectProject(fullPath)
      } else {
        console.error("Failed to create directory")
      }
    } catch (e) {
      console.error("Failed to create directory:", e)
    } finally {
      setCreating(false)
    }
  }

  async function cloneRepo() {
    const home = homeDirectory()
    const url = repoUrl().trim()
    if (!url || !home || cloning()) return

    const repoName = url.split("/").pop()?.replace(/\.git$/, "")
    if (!repoName) {
      setCloneError("Invalid repository URL")
      return
    }

    const targetPath = `${home}/${repoName}`.replace(/\/+/g, "/")

    setCloning(true)
    setCloneError(null)
    setCloneSuccess(false)
    setCloneTargetPath(targetPath)

    try {
      const res = await global.pty.create({
        command: "git",
        args: ["clone", url, targetPath],
        cwd: home,
      })

      if (!res.data?.id) {
        setCloneError("Failed to start git clone")
        setCloning(false)
        return
      }

      const ptyId = res.data.id
      setClonePtyId(ptyId)

      const handlePtyExit = (event: Event) => {
        if (event.type === "pty.exited" && event.properties?.id === ptyId) {
          if (cloneUnsubscribe) {
            cloneUnsubscribe()
            cloneUnsubscribe = null
          }
          const raw = event.properties?.exitCode
          const exitCode = typeof raw === "string" ? parseInt(raw, 10) : typeof raw === "number" ? raw : NaN
          
          setCloning(false)
          if (exitCode === 0) {
            setCloneSuccess(true)
            dirCache.clear()
          } else {
            const message = Number.isNaN(exitCode)
              ? "Clone failed (exit code unknown). Check the terminal output for details."
              : `Clone failed with exit code ${exitCode}. Check the terminal output for details.`
            setCloneError(message)
          }
        }
      }

      cloneUnsubscribe = events.subscribe(handlePtyExit)
    } catch (e) {
      console.error("Clone error:", e)
      setCloneError("Failed to clone repository")
      setCloning(false)
    }
  }

  async function cancelClone() {
    const ptyId = clonePtyId()
    if (ptyId) {
      await global.pty.remove({ ptyID: ptyId }).catch(() => {})
    }
    setCloning(false)
    setClonePtyId(null)
    setCloneError("Clone cancelled")
  }

  function openClonedProject() {
    const target = cloneTargetPath()
    if (target) {
      selectProject(target)
    }
  }

  const home = createMemo(() => homeDirectory() || "")

  return (
    <Show when={props.open}>
      {/* Backdrop */}
      <div
        class="fixed inset-0 z-50 flex items-center justify-center"
        style={{ background: "rgba(0, 0, 0, 0.5)" }}
        onClick={() => props.onClose()}
        onKeyDown={handleKeyDown}
      >
        {/* Dialog */}
        <div
          class="w-full max-w-lg mx-4 rounded-xl shadow-2xl"
          style={{ background: "var(--background-base)", border: "1px solid var(--border-base)" }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div
            class="flex items-center justify-between p-4"
            style={{ "border-bottom": "1px solid var(--border-base)" }}
          >
            <h2 class="text-lg font-semibold" style={{ color: "var(--text-strong)" }}>
              {showCloneForm() ? "Clone Git Repository" : "Open Project"}
            </h2>
            <button
              onClick={() => (showCloneForm() ? setShowCloneForm(false) : props.onClose())}
              class="p-1 rounded-md transition-colors"
              style={{ color: "var(--icon-base)" }}
            >
              <X class="w-5 h-5" />
            </button>
          </div>

          {/* Content */}
          <div class="p-4 space-y-4">
            <Show when={!showCloneForm()}>
              {/* Search input */}
              <div>
                <input
                  ref={inputRef}
                  type="text"
                  value={filter()}
                  onInput={(e) => setFilter(e.currentTarget.value)}
                  onKeyDown={handleInputKeyDown}
                  placeholder="Type to search... (Tab to complete, Enter to select)"
                  aria-label="Search directories"
                  class="w-full px-3 py-2 rounded-md text-sm font-mono"
                  style={{
                    background: "var(--background-stronger)",
                    border: "1px solid var(--border-base)",
                    color: "var(--text-base)",
                  }}
                />
                <p class="mt-1 text-xs" style={{ color: "var(--text-weak)" }}>
                  Use Tab to auto-complete. Click to select, double-click or Enter to open.
                </p>
              </div>

              {/* Results list - fixed height to prevent jumping */}
              <div 
                class="overflow-y-auto rounded-md" 
                style={{ background: "var(--surface-inset)", height: "16rem" }}
                role="listbox"
                aria-label="Directory search results"
              >
                <Show when={loading()}>
                  <div class="flex items-center justify-center h-full">
                    <Spinner class="w-5 h-5" style={{ color: "var(--text-interactive-base)" }} />
                  </div>
                </Show>

                <Show when={!loading()}>
                  <Show when={results().length === 0}>
                    <div class="flex items-center justify-center h-full text-sm" style={{ color: "var(--text-weak)" }}>
                      {filter() ? "No matching directories" : "Type to search directories"}
                    </div>
                  </Show>

                  <For each={results()}>
                    {(path, index) => {
                      const display = displayPath(path, home())
                      const dir = getDirectory(display)
                      const name = getFilename(display)
                      const isSelected = () => index() === selectedIndex()
                      const totalResults = results().length
                      
                      return (
                        <button
                          data-result-index={index()}
                          role="option"
                          aria-selected={isSelected()}
                          aria-posinset={index() + 1}
                          aria-setsize={totalResults}
                          onClick={() => setSelectedIndex(index())}
                          onDblClick={() => selectProject(path)}
                          class="w-full flex items-center gap-3 px-3 py-2 text-sm text-left transition-colors"
                          style={{
                            background: isSelected() ? "color-mix(in srgb, var(--interactive-base) 15%, transparent)" : "transparent",
                          }}
                        >
                          <Folder class="w-4 h-4 shrink-0" style={{ color: "var(--interactive-base)" }} />
                          <div class="flex items-center min-w-0 overflow-hidden">
                            <span class="truncate" style={{ color: "var(--text-weak)" }}>{dir}</span>
                            <span style={{ color: "var(--text-strong)" }}>{name}</span>
                            <span style={{ color: "var(--text-weak)" }}>/</span>
                          </div>
                        </button>
                      )
                    }}
                  </For>
                </Show>
              </div>

              {/* Open button for selected directory */}
              <div class="flex gap-2">
                <Button
                  onClick={() => {
                    const selected = results()[selectedIndex()]
                    if (selected) selectProject(selected)
                  }}
                  variant="primary"
                  class="flex-1"
                  disabled={results().length === 0}
                >
                  Open
                </Button>
              </div>

              {/* Create new folder */}
              <div class="pt-2" style={{ "border-top": "1px solid var(--border-base)" }}>
                <label class="block text-sm font-medium mb-2" style={{ color: "var(--text-strong)" }}>
                  Create new folder
                </label>
                <div class="flex gap-2">
                  <input
                    type="text"
                    value={newFolderName()}
                    onInput={(e) => setNewFolderName(e.currentTarget.value)}
                    placeholder="my-new-project"
                    class="flex-1 px-3 py-2 rounded-md text-sm"
                    style={{
                      background: "var(--background-stronger)",
                      border: "1px solid var(--border-base)",
                      color: "var(--text-base)",
                    }}
                    onKeyDown={(e) => e.key === "Enter" && createFolder()}
                  />
                  <Button onClick={createFolder} variant="primary" disabled={!newFolderName().trim() || creating()}>
                    <Show when={creating()} fallback="Create">
                      <Spinner class="w-4 h-4" />
                    </Show>
                  </Button>
                </div>
              </div>

              {/* Clone Git Repo button */}
              <div class="pt-2" style={{ "border-top": "1px solid var(--border-base)" }}>
                <button
                  onClick={() => setShowCloneForm(true)}
                  class="w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm text-left transition-colors"
                  style={{ color: "var(--text-interactive-base)" }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-inset)")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                >
                  <GitBranch class="w-4 h-4 shrink-0" style={{ color: "var(--interactive-base)" }} />
                  <span>Clone Git Repository</span>
                </button>
              </div>
            </Show>

            {/* Clone form */}
            <Show when={showCloneForm()}>
              <div class="space-y-4">
                {/* Info about private repos */}
                <div
                  class="flex items-start gap-2 p-3 rounded-md text-sm"
                  style={{ background: "var(--surface-inset)", color: "var(--text-base)" }}
                >
                  <AlertCircle class="w-4 h-4 shrink-0 mt-0.5" style={{ color: "var(--icon-warning-base)" }} />
                  <div>
                    <p class="font-medium" style={{ color: "var(--text-strong)" }}>
                      Private repositories
                    </p>
                    <p class="mt-1" style={{ color: "var(--text-weak)" }}>
                      To clone private repositories, first configure your Git credentials (SSH key) in Settings.
                    </p>
                  </div>
                </div>

                {/* Repo URL input */}
                <div>
                  <label class="block text-sm font-medium mb-2" style={{ color: "var(--text-strong)" }}>
                    Repository URL
                  </label>
                  <input
                    type="text"
                    value={repoUrl()}
                    onInput={(e) => {
                      setRepoUrl(e.currentTarget.value)
                      setCloneError(null)
                    }}
                    placeholder="https://github.com/user/repo.git or git@github.com:user/repo.git"
                    class="w-full px-3 py-2 rounded-md text-sm"
                    style={{
                      background: "var(--background-stronger)",
                      border: "1px solid var(--border-base)",
                      color: "var(--text-base)",
                    }}
                    onKeyDown={(e) => e.key === "Enter" && cloneRepo()}
                  />
                </div>

                {/* Error message */}
                <Show when={cloneError()}>
                  <div
                    class="px-3 py-2 rounded-md text-sm"
                    style={{ background: "var(--status-danger-dim)", color: "var(--status-danger-text)" }}
                  >
                    {cloneError()}
                  </div>
                </Show>

                {/* Clone target info */}
                <Show when={repoUrl().trim() && homeDirectory() && !clonePtyId()}>
                  <p class="text-xs" style={{ color: "var(--text-weak)" }}>
                    Will clone to: {homeDirectory()}/
                    {repoUrl()
                      .split("/")
                      .pop()
                      ?.replace(/\.git$/, "") || "..."}
                  </p>
                </Show>

                {/* Terminal Output */}
                <Show when={clonePtyId()}>
                  <div
                    class="rounded-md overflow-hidden"
                    style={{
                      border: "1px solid var(--border-base)",
                      height: "300px",
                    }}
                  >
                    <Terminal ptyId={clonePtyId()!} />
                  </div>
                </Show>

                {/* Success message */}
                <Show when={cloneSuccess()}>
                  <div
                    class="px-3 py-2 rounded-md text-sm"
                    style={{ background: "var(--status-success-dim)", color: "var(--status-success-text)" }}
                  >
                    Repository cloned successfully!
                  </div>
                </Show>

                {/* Actions */}
                <div class="flex gap-2">
                  <Show
                    when={cloneSuccess()}
                    fallback={
                      <>
                        <Button
                          onClick={() => {
                            setShowCloneForm(false)
                            setClonePtyId(null)
                            setCloneError(null)
                            setCloneSuccess(false)
                          }}
                          variant="secondary"
                          class="flex-1"
                          disabled={cloning()}
                        >
                          Back
                        </Button>
                        <Show when={cloning()}>
                          <Button onClick={cancelClone} variant="secondary" class="flex-1">
                            Cancel Clone
                          </Button>
                        </Show>
                        <Button
                          onClick={cloneRepo}
                          variant="primary"
                          class="flex-1"
                          disabled={!repoUrl().trim() || cloning()}
                        >
                          <Show when={cloning()} fallback="Clone">
                            <div class="flex items-center gap-2">
                              <Spinner class="w-4 h-4" />
                              <span>Cloning...</span>
                            </div>
                          </Show>
                        </Button>
                      </>
                    }
                  >
                    {/* Success state buttons */}
                    <Button
                      onClick={() => {
                        setShowCloneForm(false)
                        setClonePtyId(null)
                        setCloneError(null)
                        setCloneSuccess(false)
                        setRepoUrl("")
                      }}
                      variant="secondary"
                      class="flex-1"
                    >
                      Clone Another
                    </Button>
                    <Button onClick={openClonedProject} variant="primary" class="flex-1">
                      Open Project
                    </Button>
                  </Show>
                </div>
              </div>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  )
}
