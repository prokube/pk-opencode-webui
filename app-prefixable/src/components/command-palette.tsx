import { createSignal, createEffect, createMemo, Show, For, onMount, onCleanup } from "solid-js"
import { Portal } from "solid-js/web"
import { useNavigate } from "@solidjs/router"
import fuzzysort from "fuzzysort"
import { Search, MessageCircle, FolderOpen, Zap, Loader2, CircleHelp, ShieldAlert } from "lucide-solid"
import { useCommand, formatKeybind } from "../context/command"
import { useSync } from "../context/sync"
import { useSDK } from "../context/sdk"
import { useEvents } from "../context/events"
import { usePermission } from "../context/permission"
import { useProviders } from "../context/providers"
import { base64Encode } from "../utils/path"
import { getFilename } from "./shared"


const PROJECTS_STORAGE_KEY = "opencode.projects"

interface PaletteItem {
  id: string
  title: string
  description?: string
  category: "session" | "project" | "command"
  keybind?: string
  icon?: "session" | "session-busy" | "session-question" | "session-permission" | "project" | "command"
  onSelect: () => void
}

export function CommandPalette() {
  const command = useCommand()
  const sync = useSync()
  const { directory } = useSDK()
  const events = useEvents()
  const permission = usePermission()
  const providers = useProviders()
  const navigate = useNavigate()

  const [filter, setFilter] = createSignal("")
  const [activeIndex, setActiveIndex] = createSignal(0)
  let inputRef: HTMLInputElement | undefined
  let listRef: HTMLDivElement | undefined

  // Build palette items from all sources
  const items = createMemo((): PaletteItem[] => {
    const result: PaletteItem[] = []

    // Sessions from current project
    const sessions = sync.sessions().filter((s) => s.directory === directory && !s.time?.archived)
    const dirSlug = directory ? base64Encode(directory) : ""

    for (const s of sessions) {
      const status = events.status[s.id]?.type
      const busy = status === "busy" || status === "retry"
      const question = !!events.pendingQuestions[s.id]
      const perm = permission.pendingForSession(s.id).length > 0
      const icon = perm ? "session-permission" as const
        : question ? "session-question" as const
        : busy ? "session-busy" as const
        : "session" as const

      result.push({
        id: `session:${s.id}`,
        title: s.title || "Untitled",
        description: busy ? "Running..." : question ? "Waiting for answer" : perm ? "Permission needed" : undefined,
        category: "session",
        icon,
        onSelect: () => navigate(`/${dirSlug}/session/${s.id}`),
      })
    }

    // Projects from localStorage (with error handling for privacy mode / corrupt JSON)
    let projects: { worktree: string; name?: string }[] = []
    try {
      if (typeof localStorage !== "undefined") {
        const stored = localStorage.getItem(PROJECTS_STORAGE_KEY)
        if (stored) {
          projects = JSON.parse(stored) as { worktree: string; name?: string }[]
        }
      }
    } catch {
      projects = []
    }
    for (const p of projects) {
      if (p.worktree === directory) continue // Skip current project
      result.push({
        id: `project:${p.worktree}`,
        title: p.name || getFilename(p.worktree),
        description: p.worktree.replace(/^\/home\/[^/]+/, "~"),
        category: "project",
        icon: "project",
        onSelect: () => navigate(`/${base64Encode(p.worktree)}/session`),
      })
    }

    // Commands — all registered commands (excluding internal/passive/hidden ones)
    for (const cmd of command.commands) {
      if (cmd.hidden) continue
      if (cmd.id === "focus.escape") continue // Skip escape handler
      if (cmd.id === "palette.open") continue // Skip self
      result.push({
        id: `command:${cmd.id}`,
        title: cmd.title,
        description: cmd.description,
        category: "command",
        keybind: cmd.keybind,
        icon: "command",
        onSelect: cmd.onSelect,
      })
    }

    // Add model/agent switch commands from providers
    if (providers.providers.length > 0) {
      // Only add if not already registered as commands
      const hasModel = result.some((i) => i.id === "command:model.choose")
      if (!hasModel) {
        result.push({
          id: "command:model.choose",
          title: "Choose Model",
          description: providers.selectedModel
            ? `Current: ${providers.selectedModel.modelID}`
            : "Select the AI model to use",
          category: "command",
          icon: "command",
          onSelect: () => command.trigger("model.choose"),
        })
      }
    }

    return result
  })

  // Filtered and scored results
  const filtered = createMemo(() => {
    const q = filter().trim()

    // Check for prefix filters
    const prefixChar = q[0]
    const query = (prefixChar === ">" || prefixChar === "@" || prefixChar === "#")
      ? q.slice(1).trim()
      : q

    const categoryFilter = prefixChar === ">" ? "command"
      : prefixChar === "@" ? "session"
      : prefixChar === "#" ? "project"
      : null

    const pool = categoryFilter
      ? items().filter((i) => i.category === categoryFilter)
      : items()

    if (!query) return pool

    // Use fuzzysort for matching
    const results = fuzzysort.go(query, pool, {
      keys: ["title", "description"],
      limit: 50,
      threshold: -1000,
    })

    return results.map((r) => r.obj)
  })

  // Group filtered items by category for display
  const grouped = createMemo(() => {
    const f = filtered()
    const groups: { category: string; label: string; items: PaletteItem[] }[] = []

    const sessions = f.filter((i) => i.category === "session")
    const projects = f.filter((i) => i.category === "project")
    const commands = f.filter((i) => i.category === "command")

    if (sessions.length > 0) groups.push({ category: "session", label: "Sessions", items: sessions })
    if (projects.length > 0) groups.push({ category: "project", label: "Projects", items: projects })
    if (commands.length > 0) groups.push({ category: "command", label: "Commands", items: commands })

    return groups
  })

  // Flat list for keyboard navigation (derived from grouped)
  const flatItems = createMemo(() => grouped().flatMap((g) => g.items))

  // Reset index when filter changes
  createEffect(() => {
    filter()
    setActiveIndex(0)
  })

  // Scroll active item into view
  createEffect(() => {
    const idx = activeIndex()
    if (!listRef) return
    const el = listRef.querySelector(`[data-palette-index="${idx}"]`)
    if (el) el.scrollIntoView({ block: "nearest" })
  })

  function selectItem(item: PaletteItem) {
    command.setPaletteOpen(false)
    // Delay execution slightly so the palette closes first
    setTimeout(() => item.onSelect(), 0)
  }

  // Focus input when opened; apply initial filter if set
  createEffect(() => {
    if (command.paletteOpen()) {
      const initial = command.paletteFilter()
      setFilter(initial)
      command.setPaletteFilter("")
      setActiveIndex(0)
      // Focus after the portal renders
      requestAnimationFrame(() => inputRef?.focus())
    }
  })

  // Keyboard handler
  onMount(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (!command.paletteOpen()) return

      const flat = flatItems()
      if (e.key === "Escape") {
        e.preventDefault()
        e.stopPropagation()
        command.setPaletteOpen(false)
      } else if (e.key === "ArrowDown" && flat.length > 0) {
        e.preventDefault()
        setActiveIndex((i) => (i + 1) % flat.length)
      } else if (e.key === "ArrowUp" && flat.length > 0) {
        e.preventDefault()
        setActiveIndex((i) => (i - 1 + flat.length) % flat.length)
      } else if (e.key === "Enter" && flat.length > 0) {
        e.preventDefault()
        const item = flat[activeIndex()]
        if (item) selectItem(item)
      } else if (e.key === "Tab") {
        e.preventDefault()
        // Cycle through category prefix filters
        const current = filter().trim()
        const prefixes = ["", ">", "@", "#"]
        const currentPrefix = (current[0] === ">" || current[0] === "@" || current[0] === "#") ? current[0] : ""
        const idx = prefixes.indexOf(currentPrefix)
        const next = prefixes[(idx + 1) % prefixes.length]
        const body = currentPrefix ? current.slice(1).trim() : current
        setFilter(next ? `${next}${body ? " " + body : ""}` : body)
      }
    }
    window.addEventListener("keydown", handleKeyDown, true)
    onCleanup(() => window.removeEventListener("keydown", handleKeyDown, true))
  })

  // Pre-computed index map for O(1) lookup instead of O(n) indexOf per item
  const flatIndexMap = createMemo(() => {
    const map = new Map<string, number>()
    flatItems().forEach((item, i) => map.set(item.id, i))
    return map
  })

  function flatIndexOf(item: PaletteItem): number {
    return flatIndexMap().get(item.id) ?? -1
  }

  function renderIcon(item: PaletteItem) {
    if (item.icon === "session-busy") return <Loader2 class="w-4 h-4 animate-spin" style={{ color: "var(--icon-weak)" }} />
    if (item.icon === "session-question") return <CircleHelp class="w-4 h-4" style={{ color: "var(--icon-warning-base)" }} />
    if (item.icon === "session-permission") return <ShieldAlert class="w-4 h-4" style={{ color: "var(--interactive-base)" }} />
    if (item.icon === "session") return <MessageCircle class="w-4 h-4" style={{ color: "var(--icon-weak)" }} />
    if (item.icon === "project") return <FolderOpen class="w-4 h-4" style={{ color: "var(--icon-weak)" }} />
    return <Zap class="w-4 h-4" style={{ color: "var(--icon-weak)" }} />
  }

  return (
    <Show when={command.paletteOpen()}>
      <Portal>
        <div
          class="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]"
          style={{ background: "rgba(0,0,0,0.5)" }}
          onClick={(e) => {
            if (e.target === e.currentTarget) command.setPaletteOpen(false)
          }}
          role="presentation"
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Command Palette"
            class="w-full max-w-lg rounded-lg shadow-xl overflow-hidden flex flex-col"
            style={{
              background: "var(--background-base)",
              border: "1px solid var(--border-base)",
              "max-height": "min(480px, 60vh)",
            }}
          >
            {/* Search input */}
            <div class="px-4 py-3 shrink-0" style={{ "border-bottom": "1px solid var(--border-base)" }}>
              <div
                class="flex items-center gap-2 px-3 py-2 rounded-lg"
                style={{
                  background: "var(--surface-inset)",
                  border: "1px solid var(--border-base)",
                }}
              >
                <Search class="w-4 h-4 shrink-0" style={{ color: "var(--icon-weak)" }} />
                <input
                  ref={inputRef}
                  type="text"
                  role="combobox"
                  aria-controls="palette-listbox"
                  aria-expanded="true"
                  aria-activedescendant={`palette-option-${activeIndex()}`}
                  placeholder="Type a command, session, or project..."
                  value={filter()}
                  onInput={(e) => setFilter(e.currentTarget.value)}
                  class="flex-1 bg-transparent border-none outline-none text-sm"
                  style={{ color: "var(--text-base)" }}
                  spellcheck={false}
                  autocomplete="off"
                />
              </div>
              <div class="mt-1.5 flex items-center gap-3 text-[10px]" style={{ color: "var(--text-weak)" }}>
                <span class="opacity-70">
                  <kbd class="font-mono">↑↓</kbd> navigate
                </span>
                <span class="opacity-70">
                  <kbd class="font-mono">↵</kbd> select
                </span>
                <span class="opacity-70">
                  <kbd class="font-mono">esc</kbd> close
                </span>
                <span class="opacity-70">
                  <kbd class="font-mono">tab</kbd> filter
                </span>
                <span class="ml-auto opacity-50">
                  <kbd class="font-mono">&gt;</kbd> cmds
                  <span class="mx-1">/</span>
                  <kbd class="font-mono">@</kbd> sessions
                  <span class="mx-1">/</span>
                  <kbd class="font-mono">#</kbd> projects
                </span>
              </div>
            </div>

            {/* Results */}
            <div
              ref={listRef}
              id="palette-listbox"
              role="listbox"
              aria-label="Command Palette Results"
              class="flex-1 overflow-y-auto min-h-0"
            >
              <Show when={flatItems().length === 0}>
                <div class="px-4 py-8 text-center" style={{ color: "var(--text-weak)" }}>
                  No matching results
                </div>
              </Show>

              <For each={grouped()}>
                {(group) => (
                  <div>
                    {/* Section header */}
                    <div
                      class="px-4 pt-2.5 pb-1 text-[10px] font-semibold uppercase tracking-wider sticky top-0"
                      style={{
                        color: "var(--text-weak)",
                        background: "var(--background-base)",
                      }}
                    >
                      {group.label}
                    </div>

                    <For each={group.items}>
                      {(item) => {
                        const idx = () => flatIndexOf(item)
                        const isActive = () => idx() === activeIndex()
                        return (
                          <button
                            type="button"
                            id={`palette-option-${idx()}`}
                            role="option"
                            aria-selected={isActive()}
                            data-palette-index={idx()}
                            onClick={() => selectItem(item)}
                            onMouseEnter={() => setActiveIndex(idx())}
                            class="w-full px-4 py-2 text-left flex items-center gap-3 transition-colors"
                            style={{
                              background: isActive()
                                ? "color-mix(in srgb, var(--interactive-base) 15%, transparent)"
                                : "transparent",
                              "border-left": isActive() ? "3px solid var(--interactive-base)" : "3px solid transparent",
                            }}
                          >
                            <span class="shrink-0">{renderIcon(item)}</span>
                            <span class="min-w-0 flex-1">
                              <span class="block text-sm font-medium truncate" style={{ color: "var(--text-strong)" }}>
                                {item.title}
                              </span>
                              <Show when={item.description}>
                                <span class="block text-xs truncate" style={{ color: "var(--text-weak)" }}>
                                  {item.description}
                                </span>
                              </Show>
                            </span>
                            <Show when={item.keybind}>
                              <kbd
                                class="shrink-0 ml-2 inline-flex items-center px-1.5 py-0.5 text-[10px] font-mono rounded"
                                style={{
                                  background: "var(--surface-inset)",
                                  color: "var(--text-weak)",
                                  border: "1px solid var(--border-base)",
                                }}
                              >
                                {formatKeybind(item.keybind!)}
                              </kbd>
                            </Show>
                          </button>
                        )
                      }}
                    </For>
                  </div>
                )}
              </For>
            </div>
          </div>
        </div>
      </Portal>
    </Show>
  )
}
