import { createEffect, createMemo, For, Match, Show, Switch, untrack } from "solid-js"
import type { FileNode } from "../sdk/client"
import { useFile } from "../context/file"
import { ChevronDown, ChevronRight, File, Folder, FolderOpen } from "lucide-solid"

type Kind = "add" | "del" | "mix"

function kindLabel(kind: Kind) {
  if (kind === "add") return "A"
  if (kind === "del") return "D"
  return "M"
}

function kindColor(kind: Kind) {
  if (kind === "add") return "var(--icon-diff-add-base)"
  if (kind === "del") return "var(--icon-diff-delete-base)"
  return "var(--icon-warning-active)"
}

interface FileTreeProps {
  path: string
  level?: number
  allowed?: readonly string[]
  modified?: readonly string[]
  kinds?: ReadonlyMap<string, Kind>
  active?: string
  onFileClick?: (node: FileNode) => void
}

export function FileTree(props: FileTreeProps) {
  const file = useFile()
  const level = () => props.level ?? 0

  // Build filter set for "allowed" mode (changed files only)
  const filter = createMemo(() => {
    const allowed = props.allowed
    if (!allowed) return undefined

    const files = new Set(allowed)
    const dirs = new Set<string>()

    for (const item of allowed) {
      const parts = item.split("/")
      for (let i = 1; i < parts.length; i++) {
        dirs.add(parts.slice(0, i).join("/"))
      }
    }

    return { files, dirs }
  })

  // Build modified set for highlighting
  const marks = createMemo(() => {
    const out = new Set<string>()
    for (const item of props.modified ?? []) out.add(item)
    for (const item of props.kinds?.keys() ?? []) out.add(item)
    if (out.size === 0) return undefined
    return out
  })

  // Auto-expand directories when in filtered mode
  createEffect(() => {
    const current = filter()
    if (!current || level() !== 0) return

    for (const dir of current.dirs) {
      const state = untrack(() => file.tree.state(dir))
      if (!state?.expanded) {
        file.tree.expand(dir)
      }
    }
  })

  // List root directory on mount
  createEffect(() => {
    if (level() !== 0) return
    const state = file.tree.state(props.path)
    if (state?.loaded || state?.loading) return
    void file.tree.list(props.path)
  })

  // List expanded directories
  createEffect(() => {
    const state = file.tree.state(props.path)
    if (!state?.expanded) return
    if (state.loaded || state.loading) return
    void file.tree.list(props.path)
  })

  const nodes = createMemo(() => {
    const children = file.tree.children(props.path)
    const current = filter()
    if (!current) return children

    const parent = (path: string) => {
      const idx = path.lastIndexOf("/")
      return idx === -1 ? "" : path.slice(0, idx)
    }

    const leaf = (path: string) => {
      const idx = path.lastIndexOf("/")
      return idx === -1 ? path : path.slice(idx + 1)
    }

    // Filter to allowed items
    const out = children.filter((node) => {
      if (node.type === "file") return current.files.has(node.path)
      return current.dirs.has(node.path)
    })

    const seen = new Set(out.map((n) => n.path))

    // Add virtual entries for items in filter not yet loaded
    for (const dir of current.dirs) {
      if (parent(dir) !== props.path || seen.has(dir)) continue
      out.push({ name: leaf(dir), path: dir, absolute: dir, type: "directory", ignored: false })
      seen.add(dir)
    }

    for (const item of current.files) {
      if (parent(item) !== props.path || seen.has(item)) continue
      out.push({ name: leaf(item), path: item, absolute: item, type: "file", ignored: false })
      seen.add(item)
    }

    // Sort: directories first, then alphabetically
    out.sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1
      return a.name.localeCompare(b.name)
    })

    return out
  })

  const nodeKind = (node: FileNode) => {
    const kind = props.kinds?.get(node.path)
    if (!kind) return undefined
    if (!marks()?.has(node.path)) return undefined
    return kind
  }

  const isActive = (node: FileNode) => {
    const kind = nodeKind(node)
    return !!kind && !node.ignored
  }

  return (
    <div class="flex flex-col gap-0.5">
      <For each={nodes()}>
        {(node) => {
          const expanded = () => file.tree.state(node.path)?.expanded ?? false
          const kind = () => nodeKind(node)
          const active = () => isActive(node)

          return (
            <Switch>
              <Match when={node.type === "directory"}>
                <div>
                  <button
                    type="button"
                    onClick={() => (expanded() ? file.tree.collapse(node.path) : file.tree.expand(node.path))}
                    class="w-full h-6 flex items-center gap-1.5 rounded px-1.5 text-left transition-colors hover:bg-black/5 dark:hover:bg-white/5"
                    style={{ "padding-left": `${Math.max(0, 6 + level() * 12)}px` }}
                  >
                    <span class="w-4 h-4 flex items-center justify-center" style={{ color: "var(--icon-weak)" }}>
                      {expanded() ? <ChevronDown class="w-3 h-3" /> : <ChevronRight class="w-3 h-3" />}
                    </span>
                    <span style={{ color: "var(--icon-weak)" }}>
                      {expanded() ? <FolderOpen class="w-4 h-4" /> : <Folder class="w-4 h-4" />}
                    </span>
                    <span
                      class="flex-1 min-w-0 text-xs truncate"
                      style={{
                        color: active() ? kindColor(kind()!) : node.ignored ? "var(--text-weaker)" : "var(--text-weak)",
                      }}
                    >
                      {node.name}
                    </span>
                    <Show when={kind()}>
                      {(k) => <div class="w-1.5 h-1.5 rounded-full mr-1" style={{ background: kindColor(k()) }} />}
                    </Show>
                  </button>
                  <Show when={expanded()}>
                    <div class="relative">
                      <div
                        class="absolute top-0 bottom-0 w-px pointer-events-none opacity-30"
                        style={{ left: `${Math.max(0, 6 + level() * 12) + 8}px`, background: "var(--border-base)" }}
                      />
                      <FileTree
                        path={node.path}
                        level={level() + 1}
                        allowed={props.allowed}
                        modified={props.modified}
                        kinds={props.kinds}
                        active={props.active}
                        onFileClick={props.onFileClick}
                      />
                    </div>
                  </Show>
                </div>
              </Match>
              <Match when={node.type === "file"}>
                <button
                  type="button"
                  onClick={() => props.onFileClick?.(node)}
                  class="w-full h-6 flex items-center gap-1.5 rounded px-1.5 text-left transition-colors hover:bg-black/5 dark:hover:bg-white/5"
                  classList={{ "bg-black/5 dark:bg-white/5": node.path === props.active }}
                  style={{ "padding-left": `${Math.max(0, 6 + level() * 12 + 16)}px` }}
                >
                  <File class="w-4 h-4 shrink-0" style={{ color: "var(--icon-weak)" }} />
                  <span
                    class="flex-1 min-w-0 text-xs truncate"
                    style={{
                      color: active() ? kindColor(kind()!) : node.ignored ? "var(--text-weaker)" : "var(--text-weak)",
                    }}
                  >
                    {node.name}
                  </span>
                  <Show when={kind()}>
                    {(k) => (
                      <span class="shrink-0 w-4 text-center text-xs font-medium" style={{ color: kindColor(k()) }}>
                        {kindLabel(k())}
                      </span>
                    )}
                  </Show>
                </button>
              </Match>
            </Switch>
          )
        }}
      </For>
    </div>
  )
}
