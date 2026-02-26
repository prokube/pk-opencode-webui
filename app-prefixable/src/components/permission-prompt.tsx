import { createSignal, createMemo, For, Show, onMount, onCleanup } from "solid-js"
import { Button } from "./ui/button"
import type { PermissionRequest } from "../sdk/client"
import { FileEdit, Terminal, FileText, AlertTriangle, Check, X, CheckCheck } from "lucide-solid"

interface Props {
  requests: PermissionRequest[]
  onRespond: (id: string, response: "once" | "always" | "reject") => void
  onAutoAccept: () => void
  autoAcceptEnabled: boolean
}

function getPermissionIcon(permission: string) {
  if (permission === "edit" || permission === "write") return FileEdit
  if (permission === "bash") return Terminal
  if (permission === "read") return FileText
  return AlertTriangle
}

function getPermissionLabel(permission: string): string {
  if (permission === "edit") return "Edit file"
  if (permission === "write") return "Write file"
  if (permission === "bash") return "Run command"
  if (permission === "read") return "Read file"
  return permission
}

function getPermissionDescription(perm: PermissionRequest): string {
  // Try to get meaningful info from metadata or patterns
  if (perm.patterns?.length > 0) {
    return (
      perm.patterns.slice(0, 3).join(", ") + (perm.patterns.length > 3 ? ` (+${perm.patterns.length - 3} more)` : "")
    )
  }

  const meta = perm.metadata
  if (meta?.path) return String(meta.path)
  if (meta?.command) return String(meta.command)
  if (meta?.file) return String(meta.file)

  return "Requesting permission"
}

export function PermissionPrompt(props: Props) {
  const [selected, setSelected] = createSignal(0)
  const current = createMemo(() => props.requests[selected()] ?? props.requests[0])
  const total = createMemo(() => props.requests.length)

  function handleKeyDown(e: KeyboardEvent) {
    // Ignore when focus is on input elements
    const target = e.target as HTMLElement
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) {
      return
    }

    if (e.key === "ArrowUp" || e.key === "k") {
      e.preventDefault()
      setSelected((s) => (s - 1 + total()) % total())
    }
    if (e.key === "ArrowDown" || e.key === "j") {
      e.preventDefault()
      setSelected((s) => (s + 1) % total())
    }
    if (e.key === "Enter" || e.key === "y") {
      e.preventDefault()
      const perm = current()
      if (perm) props.onRespond(perm.id, "once")
    }
    if (e.key === "Escape" || e.key === "n") {
      e.preventDefault()
      const perm = current()
      if (perm) props.onRespond(perm.id, "reject")
    }
    if (e.key === "a") {
      e.preventDefault()
      const perm = current()
      if (perm) props.onRespond(perm.id, "always")
    }
    if (e.key === "A") {
      e.preventDefault()
      props.onAutoAccept()
    }
  }

  onMount(() => {
    document.addEventListener("keydown", handleKeyDown)
  })

  onCleanup(() => {
    document.removeEventListener("keydown", handleKeyDown)
  })

  return (
    <div
      class="rounded-lg overflow-hidden"
      style={{
        background: "var(--background-base)",
        border: "2px solid var(--interactive-base)",
        "box-shadow": "0 4px 20px rgba(0, 0, 0, 0.15)",
      }}
    >
      {/* Header */}
      <div
        class="px-4 py-2 flex items-center justify-between"
        style={{
          background: "var(--surface-inset)",
          "border-bottom": "1px solid var(--border-base)",
        }}
      >
        <div class="flex items-center gap-2">
          <span class="text-sm font-medium" style={{ color: "var(--text-interactive-base)" }}>
            Permission Request
          </span>
          <Show when={total() > 1}>
            <span
              class="text-xs px-1.5 py-0.5 rounded-full"
              style={{ background: "var(--interactive-base)", color: "white" }}
            >
              {total()}
            </span>
          </Show>
        </div>
        <Show when={!props.autoAcceptEnabled}>
          <button
            onClick={() => props.onAutoAccept()}
            class="text-xs px-2 py-1 rounded transition-colors flex items-center gap-1"
            style={{ color: "var(--text-weak)" }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-inset)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            title="Enable auto-accept for file operations (Shift+A)"
          >
            <CheckCheck class="w-3 h-3" />
            Auto-accept
          </button>
        </Show>
      </div>

      {/* Request list (when multiple) */}
      <Show when={total() > 1}>
        <div class="max-h-32 overflow-y-auto" style={{ "border-bottom": "1px solid var(--border-base)" }}>
          <For each={props.requests}>
            {(req, index) => {
              const Icon = getPermissionIcon(req.permission)
              const active = () => index() === selected()
              return (
                <button
                  onClick={() => setSelected(index())}
                  class="w-full px-4 py-2 flex items-center gap-3 text-left transition-colors"
                  style={{
                    background: active() ? "rgba(147, 112, 219, 0.1)" : "transparent",
                    "border-left": active() ? "2px solid var(--interactive-base)" : "2px solid transparent",
                  }}
                  onMouseEnter={(e) => {
                    if (!active()) e.currentTarget.style.background = "var(--surface-inset)"
                  }}
                  onMouseLeave={(e) => {
                    if (!active()) e.currentTarget.style.background = "transparent"
                  }}
                >
                  <Icon class="w-4 h-4 shrink-0" style={{ color: "var(--text-interactive-base)" }} />
                  <div class="flex-1 min-w-0">
                    <div class="text-sm truncate" style={{ color: "var(--text-strong)" }}>
                      {getPermissionLabel(req.permission)}
                    </div>
                    <div class="text-xs truncate" style={{ color: "var(--text-weak)" }}>
                      {getPermissionDescription(req)}
                    </div>
                  </div>
                </button>
              )
            }}
          </For>
        </div>
      </Show>

      {/* Current request details */}
      <Show when={current()}>
        {(perm) => {
          const Icon = getPermissionIcon(perm().permission)
          return (
            <div class="p-4">
              <div class="flex items-start gap-3 mb-4">
                <div
                  class="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
                  style={{ background: "var(--surface-inset)" }}
                >
                  <Icon class="w-5 h-5" style={{ color: "var(--text-interactive-base)" }} />
                </div>
                <div class="flex-1 min-w-0">
                  <div class="text-sm font-medium mb-1" style={{ color: "var(--text-strong)" }}>
                    {getPermissionLabel(perm().permission)}
                  </div>
                  <div class="text-sm break-all" style={{ color: "var(--text-base)" }}>
                    {getPermissionDescription(perm())}
                  </div>
                </div>
              </div>

              {/* Action buttons - right-aligned, consistent sizing */}
              <div class="flex gap-2 justify-end">
                <Button onClick={() => props.onRespond(perm().id, "reject")} variant="ghost" size="small">
                  <div class="flex items-center justify-center gap-1.5">
                    <X class="w-3.5 h-3.5" />
                    <span>Deny</span>
                  </div>
                </Button>
                <Button
                  onClick={() => props.onRespond(perm().id, "always")}
                  variant="secondary"
                  size="small"
                  title="Always allow this type of action"
                >
                  <div class="flex items-center justify-center gap-1.5">
                    <CheckCheck class="w-3.5 h-3.5" />
                    <span>Always</span>
                  </div>
                </Button>
                <Button onClick={() => props.onRespond(perm().id, "once")} variant="primary" size="small">
                  <div class="flex items-center justify-center gap-1.5">
                    <Check class="w-3.5 h-3.5" />
                    <span>Approve</span>
                  </div>
                </Button>
              </div>
            </div>
          )
        }}
      </Show>

      {/* Footer with keyboard hints */}
      <div
        class="px-4 py-2 flex gap-4 text-xs"
        style={{
          background: "var(--surface-inset)",
          "border-top": "1px solid var(--border-base)",
          color: "var(--text-weak)",
        }}
      >
        <Show when={total() > 1}>
          <span>
            <kbd class="px-1 rounded" style={{ background: "var(--background-base)" }}>
              {"\u2191\u2193"}
            </kbd>{" "}
            select
          </span>
        </Show>
        <span>
          <kbd class="px-1 rounded" style={{ background: "var(--background-base)" }}>
            y
          </kbd>{" "}
          approve
        </span>
        <span>
          <kbd class="px-1 rounded" style={{ background: "var(--background-base)" }}>
            n
          </kbd>{" "}
          deny
        </span>
        <span>
          <kbd class="px-1 rounded" style={{ background: "var(--background-base)" }}>
            a
          </kbd>{" "}
          always
        </span>
      </div>
    </div>
  )
}
