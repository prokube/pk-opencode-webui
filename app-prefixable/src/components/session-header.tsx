import { Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import { Spinner } from "./ui/spinner"
import { useLayout } from "../context/layout"
import { useMCP } from "../context/mcp"
import { usePermission } from "../context/permission"
import { useTerminal } from "../context/terminal"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useProviders } from "../context/providers"
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
  onArchive?: (session: Session) => void | Promise<void>
  onDelete?: (session: Session) => void | Promise<void>
}

export function SessionHeader(props: SessionHeaderProps) {
  const layout = useLayout()
  const mcp = useMCP()
  const permission = usePermission()
  const terminal = useTerminal()
  const { client, directory } = useSDK()
  const sync = useSync()
  const providers = useProviders()
  const navigate = useNavigate()
  const params = useParams<{ dir: string }>()

  const dirSlug = createMemo(() => (directory ? base64Encode(directory) : params.dir))
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
    const session = props.session
    const serverTitle = session?.title
    const optimistic = optimisticTitle()
    if (optimistic === null) return
    if (serverTitle === optimistic) setOptimisticTitle(null)
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
    if (!session || !trimmed || trimmed === session.title) { setRenaming(false); return }
    setOptimisticTitle(trimmed)
    setRenaming(false)
    client.session.update({ sessionID: session.id, title: trimmed })
      .then(() => props.onRename?.(session.id, trimmed))
      .catch(err => {
        console.error("Failed to rename session", err)
        setOptimisticTitle(null)
      })
  }

  async function renameWithAI() {
    if (aiRenaming()) return
    setAiRenaming(true)
    setMenuOpen(false)
    const session = props.session
    if (!session) { setAiRenaming(false); return }

    const msgs = sync.messages(session.id)
    const userMsgs = msgs
      .filter((m) => m.info.role === "user")
      .slice(0, 10)
      .map((m) => {
        const text = m.parts
          .filter((p) => p.type === "text")
          .map((p) => (p as { text?: string }).text ?? "")
          .join(" ")
        return text.slice(0, 500)
      })
      .filter((t) => t.length > 0)

    if (userMsgs.length === 0) { setAiRenaming(false); return }

    const promptText = `Suggest a short title (8 words or fewer) for the following conversation. Reply with only the title, no punctuation, no quotes.\n\n${userMsgs.join("\n")}`

    // Use last assistant message's model or fall back to selected model
    const lastAssistant = (() => {
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].info.role === "assistant") return msgs[i]
      }
      return undefined
    })()
    const model = lastAssistant
      ? {
          providerID: (lastAssistant.info as AssistantMessage).providerID,
          modelID: (lastAssistant.info as AssistantMessage).modelID,
        }
      : providers.selectedModel

    const childRes = await client.session.create({ parentID: session.id }).catch((err: unknown) => {
      console.error("[AI Rename] Failed to create child session:", err)
      return null
    })

    const childID = childRes?.data?.id

    if (!childID) {
      setAiRenaming(false)
      return
    }

    const cleanup = () =>
      client.session.delete({ sessionID: childID })
        .catch(err => console.warn("[AI Rename] Failed to delete child session:", childID, err))

    const res = await client.session
      .prompt({
        sessionID: childID,
        parts: [{ type: "text", text: promptText }],
        agent: providers.selectedAgent || "build",
        ...(model ? { model } : {}),
      })
      .catch((err: unknown) => {
        console.error("[AI Rename] Prompt failed:", err)
        return null
      })

    await cleanup()
    setAiRenaming(false)

    if (!res?.data) return

    const title = res.data.parts
      .filter((p) => p.type === "text")
      .map((p) => (p as { text?: string }).text ?? "")
      .join("")
      .trim()
      .replace(/^["']+|["']+$/g, "")
      .trim()

    if (!title) {
      console.error("[AI Rename] Empty title returned")
      return
    }

    // Pre-fill the rename input with the AI suggestion so user can confirm/edit
    setRenameValue(title)
    setRenaming(true)
  }

  // Whether the session has messages (for enabling AI rename)
  const hasMessages = createMemo(() => {
    const session = props.session
    if (!session) return false
    return sync.messages(session.id).length > 0
  })

  function archiveSession() {
    setMenuOpen(false)
    const session = props.session
    if (!session) return
    props.onArchive?.(session)
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
        if (props.onDelete) {
          props.onDelete(session)
        } else {
          navigate(`/${dirSlug()}/session`)
        }
      })
      .catch(err => {
        console.error("Failed to delete session", err)
        setDeleteError("Failed to delete session. Please try again.")
      })
      .finally(() => setDeleting(false))
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
                <>
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
                  {/* Spinner shown while AI rename is in progress */}
                  <Show when={aiRenaming()}>
                    <Spinner class="w-3.5 h-3.5 shrink-0" style={{ color: "var(--text-interactive-base)" }} />
                  </Show>
                </>
              }
            >
              {/* dataset cancel flag prevents Escape triggering onBlur commit */}
              <input
                class="text-sm font-medium bg-transparent outline-none border-b min-w-0"
                style={{
                  color: "var(--text-strong)",
                  "border-color": "var(--border-interactive)",
                  width: "16rem",
                }}
                value={renameValue()}
                autofocus
                ref={(el) => setTimeout(() => { el.focus(); el.select() }, 0)}
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

            {/* ⋯ more-options dropdown — only show when session is loaded and not AI renaming */}
            <Show when={props.session && !aiRenaming()}>
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
                      disabled={!hasMessages()}
                      style={{
                        color: hasMessages() ? "var(--text-base)" : "var(--text-weak)",
                        opacity: hasMessages() ? 1 : 0.5,
                        cursor: hasMessages() ? "pointer" : "not-allowed",
                      }}
                      onMouseEnter={(e) => {
                        if (hasMessages()) e.currentTarget.style.background = "var(--surface-inset)"
                      }}
                      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                      onClick={() => {
                        if (hasMessages()) renameWithAI()
                      }}
                      title={hasMessages() ? "Suggest a title using AI" : "Send a message first to enable AI rename"}
                    >
                      <Sparkles
                        class="w-3.5 h-3.5 shrink-0"
                        style={{ color: hasMessages() ? "var(--text-interactive-base)" : "var(--icon-weak)" }}
                      />
                      Rename with AI
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
      </div>

      {/* Right side: PR button + panel toggles in one container */}
      <div class="flex items-center gap-1">
        {/* PR button */}
        <Show when={props.onSendPrompt}>
          {(sendPrompt) => <PrButton onSendPrompt={sendPrompt()} />}
        </Show>

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
