import { Show, createEffect, createSignal, onCleanup } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import { Spinner } from "./ui/spinner"
import { useLayout } from "../context/layout"
import { useMCP } from "../context/mcp"
import { usePermission } from "../context/permission"
import { useTerminal } from "../context/terminal"
import { useSDK } from "../context/sdk"
import { useProviders } from "../context/providers"
import { useSync } from "../context/sync"
import { ConfirmDialog } from "./confirm-dialog"
import { PanelBottom, FileCode, ListTodo, Plug, ArrowLeft, Users, MoreHorizontal, Pencil, Archive, Trash2, Sparkles } from "lucide-solid"
import { base64Encode } from "../utils/path"
import { PrButton } from "./pr-button"
import type { AssistantMessage, Session } from "../sdk/client"

interface SessionHeaderProps {
  session: Session | null | undefined
  processing: boolean
  onOpenMCPDialog: () => void
  onSendPrompt?: (prompt: string) => void
  onRename?: (sessionId: string, title: string) => void
  onArchive: (session: Session) => void
  onDelete: (session: Session) => void
}

export function SessionHeader(props: SessionHeaderProps) {
  const layout = useLayout()
  const mcp = useMCP()
  const permission = usePermission()
  const terminal = useTerminal()
  const { client, directory } = useSDK()
  const providers = useProviders()
  const sync = useSync()
  const navigate = useNavigate()
  const params = useParams<{ dir: string }>()

  const dirSlug = () => (directory ? base64Encode(directory) : params.dir)
  const parentId = () => props.session?.parentID
  const [renaming, setRenaming] = createSignal(false)
  const [renameValue, setRenameValue] = createSignal("")
  const [menuOpen, setMenuOpen] = createSignal(false)
  const [confirmDelete, setConfirmDelete] = createSignal(false)
  const [deleting, setDeleting] = createSignal(false)
  const [deleteError, setDeleteError] = createSignal<string | null>(null)
  const [optimisticTitle, setOptimisticTitle] = createSignal<string | null>(null)
  const [aiRenaming, setAiRenaming] = createSignal(false)

  // Clear optimistic title when SSE confirms the rename (server title matches)
  createEffect(() => {
    const title = props.session?.title
    const optimistic = optimisticTitle()
    if (optimistic === null) return
    if (title === optimistic) setOptimisticTitle(null)
  })

  // Clear when switching sessions (different ID)
  createEffect(() => {
    props.session?.id
    setOptimisticTitle(null)
  })

  function navigateToParent() {
    const id = parentId()
    if (!id) return
    navigate(`/${dirSlug()}/session/${id}`)
  }

  function commitRename(value: string) {
    const trimmed = value.trim()
    const session = props.session
    if (!trimmed || trimmed === session?.title) { setRenaming(false); return }
    if (!session) { setRenaming(false); return }
    setOptimisticTitle(trimmed)
    setRenaming(false)
    client.session.update({ sessionID: session.id, title: trimmed })
      .then(() => props.onRename?.(session.id, trimmed))
      .catch((err: unknown) => {
        console.error("Failed to rename session", err)
        setOptimisticTitle(null)
      })
  }

  function archiveSession() {
    setMenuOpen(false)
    const session = props.session
    if (!session) return
    props.onArchive(session)
  }

  function confirmAndDelete() {
    if (deleting()) return
    const session = props.session
    if (!session) return
    setDeleteError(null)
    setDeleting(true)
    client.session.delete({ sessionID: session.id })
      .then(() => {
        setConfirmDelete(false)
        props.onDelete(session)
      })
      .catch((err: unknown) => {
        console.error("Failed to delete session", err)
        setDeleteError("Failed to delete session. Please try again.")
      })
      .finally(() => setDeleting(false))
  }

  function renameWithAI() {
    if (aiRenaming()) return
    const session = props.session
    if (!session) return

    const msgs = sync.messages(session.id)
    if (!msgs.length) return

    // Find last assistant message for model extraction and summary
    const ref = { msg: undefined as typeof msgs[number] | undefined }
    for (const m of msgs) {
      if (m.info.role === "assistant") ref.msg = m
    }

    // Build summary: prefer assistant text, fall back to user messages
    const summary = ref.msg
      ? ref.msg.parts
          .filter(p => p.type === "text")
          .map(p => (p as { text?: string }).text ?? "")
          .join("\n")
          .slice(0, 500)
      : msgs
          .filter(m => m.info.role === "user")
          .slice(0, 10)
          .map(m => m.parts
            .filter(p => p.type === "text")
            .map(p => (p as { text?: string }).text ?? "")
            .join(" ")
            .slice(0, 500))
          .filter(t => t.length > 0)
          .join("\n")

    if (!summary.trim()) return

    setAiRenaming(true)
    setMenuOpen(false)

    const model = (() => {
      // Prefer the model from the last assistant message
      if (ref.msg?.info.role === "assistant") {
        const info = ref.msg.info as AssistantMessage
        if (info.providerID && info.modelID) {
          return { providerID: info.providerID, modelID: info.modelID }
        }
      }
      // Fall back to currently selected model
      const sel = providers.selectedModel
      if (!sel?.providerID || !sel?.modelID) return undefined
      return { providerID: sel.providerID, modelID: sel.modelID }
    })()

    const agent = providers.selectedAgent || "build"
    const context = ref.msg ? "assistant reply" : "user messages"
    const prompt = `Suggest a concise session title (8 words or fewer) for this conversation based on the following ${context}. Reply with ONLY the title text, nothing else.\n\n${summary}`

    // Create a child session for the rename suggestion
    const ref2 = { childId: "" }
    client.session.create({ parentID: session.id })
      .then((res) => {
        if (!res.data) throw new Error("Failed to create child session")
        ref2.childId = res.data.id
        const payload: {
          sessionID: string
          parts: { type: "text"; text: string }[]
          agent: string
          model?: { providerID: string; modelID: string }
        } = {
          sessionID: ref2.childId,
          parts: [{ type: "text", text: prompt }],
          agent,
        }
        if (model) payload.model = model
        return client.session.prompt(payload)
      })
      .then((res) => {
        // Extract the suggestion text from response parts
        const parts = res.data?.parts ?? []
        const suggestion = parts
          .filter((p: { type: string }) => p.type === "text")
          .map((p: { type: string; text?: string }) => p.text ?? "")
          .join("")
          .trim()
          // Strip surrounding quotes
          .replace(/^["']|["']$/g, "")
          .trim()

        if (suggestion) {
          setRenameValue(suggestion)
          setRenaming(true)
        }
      })
      .catch((err: unknown) => console.error("AI rename failed", err))
      .finally(() => {
        setAiRenaming(false)
        // Clean up child session
        if (ref2.childId) {
          client.session.delete({ sessionID: ref2.childId })
            .catch((err: unknown) => console.warn("Failed to clean up AI rename child session", err))
        }
      })
  }

  function handleDocClick(e: MouseEvent) {
    if (!menuOpen()) return
    const target = e.target
    if (!(target instanceof Element)) return
    if (!target.closest("[data-session-menu]")) setMenuOpen(false)
  }

  // Attach/detach document click listener reactively
  createEffect(() => {
    if (menuOpen()) {
      document.addEventListener("click", handleDocClick, { capture: true })
    } else {
      document.removeEventListener("click", handleDocClick, { capture: true })
    }
  })

  onCleanup(() => {
    document.removeEventListener("click", handleDocClick, { capture: true })
  })

  return (
    <header
      class="flex items-center justify-between px-4 py-2"
      style={{
        background: "var(--background-base)",
        "border-bottom": "1px solid var(--border-base)",
      }}
    >
      {/* Left side: Session info */}
      <div class="flex items-center gap-3 min-w-0">
        {/* Back button for child sessions */}
        <Show when={parentId()}>
          <button
            onClick={navigateToParent}
            class="flex items-center gap-1.5 px-2 py-1 text-xs rounded-md transition-colors"
            style={{
              border: "1px solid var(--border-base)",
              color: "var(--text-base)",
              background: "transparent",
            }}
            onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = "var(--surface-inset)")}
            onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = "transparent")}
            title="Return to parent session"
          >
            <ArrowLeft class="w-3 h-3" />
            <span>Back</span>
          </button>
        </Show>

        <div class="min-w-0">
          <div class="flex items-center gap-2">
            {/* Sub-agent indicator */}
            <Show when={parentId()}>
              <Users class="w-3.5 h-3.5 shrink-0" style={{ color: "var(--text-interactive-base)" }} />
            </Show>
            <Show
              when={renaming()}
              fallback={
                <h1
                  class="text-sm font-medium truncate cursor-text"
                  style={{ color: "var(--text-strong)" }}
                  title="Double-click to rename"
                  onDblClick={() => {
                    if (!props.session) return
                    setRenameValue(props.session.title ?? "")
                    setRenaming(true)
                  }}
                >
                  {optimisticTitle() ?? (props.session?.title || "New Session")}
                </h1>
              }
            >
              <input
                class="text-sm font-medium bg-transparent outline-none border-b min-w-0"
                style={{
                  color: "var(--text-strong)",
                  "border-color": "var(--border-interactive)",
                  width: "16rem",
                }}
                value={renameValue()}
                ref={(el) => queueMicrotask(() => { if (!el?.isConnected) return; el.focus(); el.select() })}
                onInput={(e) => setRenameValue(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename(e.currentTarget.value)
                  else if (e.key === "Escape") {
                    e.currentTarget.dataset.cancelRename = "true"
                    setRenaming(false)
                  }
                }}
                onBlur={(e) => {
                  if (e.currentTarget.dataset.cancelRename === "true") return
                  commitRename(e.currentTarget.value)
                }}
              />
            </Show>

            {/* More-options dropdown -- only show when session is loaded */}
            <Show when={props.session}>
              <div class="relative" data-session-menu>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    setMenuOpen((v) => !v)
                  }}
                  class="p-0.5 rounded transition-colors"
                  style={{ color: "var(--icon-weak)" }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = "var(--icon-base)")}
                  onMouseLeave={(e) => (e.currentTarget.style.color = "var(--icon-weak)")}
                  title="More options"
                  aria-label="More session options"
                  aria-haspopup="true"
                  aria-expanded={menuOpen()}
                >
                  <MoreHorizontal class="w-4 h-4" />
                </button>

                <Show when={menuOpen()}>
                  <div
                    class="absolute left-0 top-full mt-1 w-44 rounded-md shadow-lg z-30 py-1"
                    style={{
                      background: "var(--background-base)",
                      border: "1px solid var(--border-base)",
                    }}
                    data-session-menu
                  >
                    {/* Rename */}
                    <button
                      class="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left transition-colors"
                      style={{ color: "var(--text-base)" }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-inset)")}
                      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                      onClick={() => {
                        setMenuOpen(false)
                        setRenameValue(props.session?.title ?? "")
                        setRenaming(true)
                      }}
                    >
                      <Pencil class="w-3.5 h-3.5 shrink-0" style={{ color: "var(--icon-weak)" }} />
                      Rename
                    </button>

                    {/* Rename with AI */}
                    <button
                      class="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left transition-colors"
                      style={{ color: "var(--text-base)", ...(aiRenaming() ? { opacity: "0.6" } : {}) }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-inset)")}
                      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                      onClick={renameWithAI}
                    >
                      <Show when={aiRenaming()} fallback={<Sparkles class="w-3.5 h-3.5 shrink-0" style={{ color: "var(--icon-weak)" }} />}>
                        <Spinner class="w-3.5 h-3.5 shrink-0" />
                      </Show>
                      {aiRenaming() ? "Suggesting..." : "Rename with AI"}
                    </button>

                    {/* Archive */}
                    <button
                      class="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left transition-colors"
                      style={{ color: "var(--text-base)" }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-inset)")}
                      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                      onClick={archiveSession}
                    >
                      <Archive class="w-3.5 h-3.5 shrink-0" style={{ color: "var(--icon-weak)" }} />
                      Archive
                    </button>

                    {/* Separator */}
                    <div class="my-1" style={{ "border-top": "1px solid var(--border-base)" }} />

                    {/* Delete */}
                    <button
                      class="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left transition-colors"
                      style={{ color: "var(--text-critical-base)" }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-inset)")}
                      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                      onClick={() => {
                        setMenuOpen(false)
                        setDeleteError(null)
                        setConfirmDelete(true)
                      }}
                    >
                      <Trash2 class="w-3.5 h-3.5 shrink-0" />
                      Delete
                    </button>
                  </div>
                </Show>
              </div>
            </Show>
          </div>
          <Show when={props.session}>
            <p class="text-[11px] truncate" style={{ color: "var(--text-weak)" }}>
              {parentId() ? "Sub-agent session" : props.session?.id}
            </p>
          </Show>
        </div>
      </div>

      {/* Status indicators */}
      <div class="flex items-center gap-3">
        {/* Permission Auto-Accept Indicator */}
        <Show when={permission.autoAcceptEnabled()}>
          <button
            onClick={permission.toggleAutoAccept}
            class="flex items-center gap-1.5 px-2 py-1 text-xs rounded-md transition-colors"
            style={{
              border: "1px solid var(--border-base)",
              color: "var(--text-base)",
            }}
            onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = "var(--surface-inset)")}
            onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = "transparent")}
            title="Auto-accepting file operation permissions (click to disable)"
          >
            <div class="w-1.5 h-1.5 rounded-full" style={{ background: "var(--icon-success-base)" }} />
            <span>Auto-approve</span>
          </button>
        </Show>

        {/* Pending Permissions Indicator */}
        <Show when={!permission.autoAcceptEnabled() && permission.pending().length > 0}>
          <div
            class="flex items-center gap-1.5 px-2 py-1 text-xs rounded-md"
            style={{
              border: "1px solid var(--interactive-base)",
              color: "var(--text-interactive-base)",
              background: "rgba(147, 112, 219, 0.1)",
            }}
          >
            <div class="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: "var(--interactive-base)" }} />
            <span>{permission.pending().length} pending</span>
          </div>
        </Show>

        {/* Processing indicator */}
        <Show when={props.processing}>
          <div class="flex items-center gap-1.5 text-xs" style={{ color: "var(--text-interactive-base)" }}>
            <Spinner class="w-3.5 h-3.5" />
            <span>Processing...</span>
          </div>
        </Show>

        {/* AI rename spinner */}
        <Show when={aiRenaming()}>
          <div class="flex items-center gap-1.5 text-xs" style={{ color: "var(--text-weak)" }}>
            <Spinner class="w-3.5 h-3.5" />
            <span>AI renaming...</span>
          </div>
        </Show>
      </div>

      {/* Right side: PR button + panel toggles in one container */}
      <div class="flex items-center gap-1">
        {/* PR button — only render when onSendPrompt is provided */}
        <Show when={props.onSendPrompt}>{(sendPrompt) =>
          <PrButton onSendPrompt={sendPrompt()} />
        }</Show>

        {/* Divider */}
        <div class="w-px h-4 mx-1" style={{ background: "var(--border-base)" }} />

        {/* MCP toggle */}
        <button
          onClick={props.onOpenMCPDialog}
          class="p-1.5 rounded-md transition-colors relative"
          style={{
            color: mcp.stats().enabled > 0 ? "var(--text-interactive-base)" : "var(--icon-base)",
            background: mcp.stats().enabled > 0 ? "var(--surface-inset)" : "transparent",
          }}
          onMouseEnter={(e) => {
            if (mcp.stats().enabled === 0) (e.currentTarget as HTMLElement).style.background = "var(--surface-inset)"
          }}
          onMouseLeave={(e) => {
            if (mcp.stats().enabled === 0) (e.currentTarget as HTMLElement).style.background = "transparent"
          }}
          title="MCP Servers"
          aria-label="MCP Servers"
        >
          <Plug class="w-4 h-4" />
          <Show when={mcp.stats().failed}>
            <div
              class="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full"
              style={{ background: "var(--icon-critical-base)" }}
            />
          </Show>
        </button>

        {/* Review panel toggle */}
        <button
          onClick={layout.review.toggle}
          class="p-1.5 rounded-md transition-colors"
          style={{
            color: layout.review.opened() ? "var(--text-interactive-base)" : "var(--icon-base)",
            background: layout.review.opened() ? "var(--surface-inset)" : "transparent",
          }}
          onMouseEnter={(e) => {
            if (!layout.review.opened()) (e.currentTarget as HTMLElement).style.background = "var(--surface-inset)"
          }}
          onMouseLeave={(e) => {
            if (!layout.review.opened()) (e.currentTarget as HTMLElement).style.background = "transparent"
          }}
          title="Toggle Review Panel (Cmd+Shift+R)"
          aria-label="Toggle Review Panel"
        >
          <FileCode class="w-4 h-4" />
        </button>

        {/* Info panel toggle */}
        <button
          onClick={layout.info.toggle}
          class="p-1.5 rounded-md transition-colors"
          style={{
            color: layout.info.opened() ? "var(--text-interactive-base)" : "var(--icon-base)",
            background: layout.info.opened() ? "var(--surface-inset)" : "transparent",
          }}
          onMouseEnter={(e) => {
            if (!layout.info.opened()) (e.currentTarget as HTMLElement).style.background = "var(--surface-inset)"
          }}
          onMouseLeave={(e) => {
            if (!layout.info.opened()) (e.currentTarget as HTMLElement).style.background = "transparent"
          }}
          title="Toggle Info Panel (Cmd+Shift+I)"
          aria-label="Toggle Info Panel"
        >
          <ListTodo class="w-4 h-4" />
        </button>

        {/* Terminal toggle */}
        <button
          onClick={() => terminal.toggle(directory)}
          class="p-1.5 rounded-md transition-colors"
          style={{
            color: terminal.opened() ? "var(--text-interactive-base)" : "var(--icon-base)",
            background: terminal.opened() ? "var(--surface-inset)" : "transparent",
          }}
          onMouseEnter={(e) => {
            if (!terminal.opened()) (e.currentTarget as HTMLElement).style.background = "var(--surface-inset)"
          }}
          onMouseLeave={(e) => {
            if (!terminal.opened()) (e.currentTarget as HTMLElement).style.background = "transparent"
          }}
          title="Toggle Terminal (Ctrl+`)"
          aria-label="Toggle Terminal"
        >
          <PanelBottom class="w-4 h-4" />
        </button>
      </div>

      {/* Delete confirmation dialog */}
      <ConfirmDialog
        open={confirmDelete()}
        title="Delete session?"
        message={`This will permanently delete "${props.session?.title || "this session"}". This cannot be undone.`}
        confirmLabel={deleting() ? "Deleting..." : "Delete"}
        confirmDisabled={deleting()}
        cancelDisabled={deleting()}
        cancelLabel="Cancel"
        variant="danger"
        error={deleteError() ?? undefined}
        onConfirm={confirmAndDelete}
        onCancel={() => {
          if (deleting()) return
          setDeleteError(null)
          setConfirmDelete(false)
        }}
      />
    </header>
  )
}
