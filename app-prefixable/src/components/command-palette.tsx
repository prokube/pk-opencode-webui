import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { useNavigate } from "@solidjs/router"
import { FolderOpen, Loader2, MessageCircle, Search, Zap } from "lucide-solid"
import { formatKeybind, useCommand } from "../context/command"
import { useProjects } from "../context/projects"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import type { Session } from "../sdk/client"
import { base64Encode } from "../utils/path"
import { createBackdropDismiss } from "../utils/backdrop"
import { filterPaletteEntries, paletteQuery, type PaletteEntry } from "../utils/command-palette"
import { getFilename } from "./shared"

export function CommandPalette() {
  const command = useCommand()
  const projects = useProjects()
  const sdk = useSDK()
  const sync = useSync()
  const navigate = useNavigate()
  const [query, setQuery] = createSignal("")
  const [sessions, setSessions] = createSignal<Session[]>([])
  const [loading, setLoading] = createSignal(false)
  const [searchError, setSearchError] = createSignal(false)
  const [active, setActive] = createSignal(0)
  const backdrop = createBackdropDismiss(command.closePalette)
  let input: HTMLInputElement | undefined
  let list: HTMLDivElement | undefined
  let dialog: HTMLDivElement | undefined
  let previousFocus: HTMLElement | undefined

  const localSessions = createMemo(() => sync.sessions()
    .filter((session) => !session.parentID && !session.time?.archived)
    .sort((a, b) => (b.time?.updated ?? b.time?.created ?? 0) - (a.time?.updated ?? a.time?.created ?? 0))
    .slice(0, 8))

  createEffect(on(command.paletteOpen, (open) => {
    if (!open) {
      if (previousFocus?.isConnected) previousFocus.focus()
      previousFocus = undefined
      return
    }
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    setQuery(command.paletteQuery())
    setSessions(localSessions())
    setActive(0)
    requestAnimationFrame(() => input?.focus())
  }))

  createEffect(on([command.paletteOpen, query], ([open, value]) => {
    if (!open) return
    const parsed = paletteQuery(value)
    if (parsed.category && parsed.category !== "session") {
      setLoading(false)
      setSearchError(false)
      return
    }
    if (!parsed.text) {
      setSessions(localSessions())
      setLoading(false)
      setSearchError(false)
      return
    }
    const controller = new AbortController()
    const timer = setTimeout(() => {
      setLoading(true)
      setSearchError(false)
      sdk.global.session.list(
        { search: parsed.text, roots: true, limit: 50 },
        { signal: controller.signal },
      ).then((response) => {
        if (!controller.signal.aborted) setSessions((response.data ?? []).filter((session) => !session.time?.archived))
      }).catch(() => {
        if (!controller.signal.aborted) setSearchError(true)
      }).finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    }, 150)
    onCleanup(() => {
      clearTimeout(timer)
      controller.abort()
    })
  }))

  const entries = createMemo(() => {
    const result: PaletteEntry[] = []
    for (const session of sessions()) {
      result.push({
        id: `session:${session.id}`,
        title: session.title || "Untitled",
        description: session.directory,
        category: "session",
        run: () => {
          projects.touch(session.directory)
          navigate(`/${base64Encode(session.directory)}/session/${session.id}`)
        },
      })
    }
    for (const project of projects.recent()) {
      result.push({
        id: `project:${project.worktree}`,
        title: project.name || getFilename(project.worktree),
        description: project.worktree.replace(/^\/home\/[^/]+/, "~"),
        category: "project",
        run: () => {
          projects.touch(project.worktree)
          navigate(`/${base64Encode(project.worktree)}/session`)
        },
      })
    }
    for (const item of command.commands) {
      if (item.hidden || item.id === "focus.escape" || item.id === "palette.open") continue
      result.push({
        id: `command:${item.id}`,
        title: item.title,
        description: item.description,
        category: "command",
        keybind: item.keybindDisplay ?? item.keybind,
        run: item.onSelect,
      })
    }
    return result
  })
  const filtered = createMemo(() => filterPaletteEntries(entries(), query()))
  const groups = createMemo(() => ([
    { type: "session" as const, title: "Sessions" },
    { type: "project" as const, title: "Projects" },
    { type: "command" as const, title: "Commands" },
  ].map((group) => ({ ...group, items: filtered().filter((item) => item.category === group.type) })).filter((group) => group.items.length)))
  const ordered = createMemo(() => groups().flatMap((group) => group.items))

  createEffect(() => {
    query()
    setActive(0)
  })
  createEffect(() => {
    const index = Math.min(active(), Math.max(0, ordered().length - 1))
    if (index !== active()) setActive(index)
    list?.querySelector(`[data-palette-index="${index}"]`)?.scrollIntoView({ block: "nearest" })
  })

  function select(entry: PaletteEntry | undefined) {
    if (!entry) return
    command.closePalette()
    queueMicrotask(entry.run)
  }

  function keydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault()
      command.closePalette()
      return
    }
    if (event.key === "ArrowDown" && ordered().length) {
      event.preventDefault()
      setActive((index) => (index + 1) % ordered().length)
      return
    }
    if (event.key === "ArrowUp" && ordered().length) {
      event.preventDefault()
      setActive((index) => (index - 1 + ordered().length) % ordered().length)
      return
    }
    if (event.key === "Home" && ordered().length) {
      event.preventDefault()
      setActive(0)
      return
    }
    if (event.key === "End" && ordered().length) {
      event.preventDefault()
      setActive(ordered().length - 1)
      return
    }
    if (event.key === "Enter") {
      event.preventDefault()
      select(ordered()[active()])
      return
    }
    if (event.key === "Tab" && dialog) {
      const focusable = [...dialog.querySelectorAll<HTMLElement>('input, button:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      if (!focusable.length) return
      event.preventDefault()
      const current = focusable.indexOf(document.activeElement as HTMLElement)
      const next = event.shiftKey
        ? (current <= 0 ? focusable.length - 1 : current - 1)
        : (current >= focusable.length - 1 ? 0 : current + 1)
      focusable[next]?.focus()
    }
  }

  function icon(entry: PaletteEntry) {
    if (entry.category === "session") return <MessageCircle class="w-4 h-4" />
    if (entry.category === "project") return <FolderOpen class="w-4 h-4" />
    return <Zap class="w-4 h-4" />
  }

  return (
    <Show when={command.paletteOpen()}>
      <Portal>
        <div
          class="fixed inset-0 z-[90] flex items-start justify-center px-4 pt-[12vh]"
          style={{ background: "rgba(0,0,0,0.5)" }}
          onMouseDown={backdrop.onMouseDown}
          onClick={backdrop.onClick}
          role="presentation"
        >
          <div
            ref={dialog}
            role="dialog"
            aria-modal="true"
            aria-label="Command Palette"
            class="w-full max-w-xl rounded-xl shadow-xl overflow-hidden flex flex-col"
            style={{ background: "var(--background-base)", border: "1px solid var(--border-base)", "max-height": "min(560px, 72vh)" }}
            onKeyDown={keydown}
          >
            <div class="p-3" style={{ "border-bottom": "1px solid var(--border-base)" }}>
              <div class="flex items-center gap-2 px-3 py-2 rounded-lg" style={{ background: "var(--surface-inset)" }}>
                <Search class="w-4 h-4" style={{ color: "var(--icon-weak)" }} />
                <input
                  ref={input}
                  role="combobox"
                  aria-controls="command-palette-results"
                  aria-expanded="true"
                  aria-activedescendant={ordered().length ? `command-palette-option-${active()}` : undefined}
                  value={query()}
                  onInput={(event) => setQuery(event.currentTarget.value)}
                  placeholder="Commands, sessions, or projects..."
                  class="flex-1 bg-transparent outline-none text-sm"
                  style={{ color: "var(--text-base)" }}
                  autocomplete="off"
                  spellcheck={false}
                />
                <Show when={loading()}><Loader2 class="w-4 h-4 animate-spin" /></Show>
                <kbd class="text-[10px] px-1.5 py-0.5 rounded" style={{ color: "var(--text-weak)", border: "1px solid var(--border-base)" }}>Esc</kbd>
              </div>
              <div class="pt-2 flex gap-3 text-[10px]" style={{ color: "var(--text-weak)" }}>
                <span><kbd>&gt;</kbd> commands</span><span><kbd>@</kbd> sessions</span><span><kbd>#</kbd> projects</span>
              </div>
            </div>
            <div ref={list} id="command-palette-results" role="listbox" class="flex-1 min-h-0 overflow-y-auto py-1" aria-busy={loading()}>
              <Show when={searchError()}>
                <div class="px-4 py-2 text-xs" role="status" style={{ color: "var(--text-critical-base)" }}>
                  Session search failed; commands and projects are still available.
                </div>
              </Show>
              <Show when={!filtered().length && !loading()}>
                <div class="px-4 py-8 text-center text-sm" style={{ color: "var(--text-weak)" }}>
                  {searchError() ? "Sessions could not be loaded" : "No matching results"}
                </div>
              </Show>
              <For each={groups()}>
                {(group) => (
                  <div>
                    <div class="px-4 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider" style={{ color: "var(--text-weak)" }}>{group.title}</div>
                    <For each={group.items}>
                      {(entry) => {
                        const index = () => ordered().indexOf(entry)
                        const selected = () => index() === active()
                        return (
                          <button
                            type="button"
                            id={`command-palette-option-${index()}`}
                            role="option"
                            aria-selected={selected()}
                            data-palette-index={index()}
                            onMouseEnter={() => setActive(index())}
                            onClick={() => select(entry)}
                            class="w-full px-4 py-2 flex items-center gap-3 text-left"
                            style={{ background: selected() ? "var(--surface-inset)" : "transparent", color: "var(--text-base)" }}
                          >
                            <span style={{ color: "var(--icon-weak)" }}>{icon(entry)}</span>
                            <span class="min-w-0 flex-1">
                              <span class="block text-sm truncate">{entry.title}</span>
                              <Show when={entry.description}><span class="block text-xs truncate" style={{ color: "var(--text-weak)" }}>{entry.description}</span></Show>
                            </span>
                            <Show when={entry.keybind}><kbd class="text-[10px] px-1.5 py-0.5 rounded" style={{ color: "var(--text-weak)", border: "1px solid var(--border-base)" }}>{formatKeybind(entry.keybind!)}</kbd></Show>
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
