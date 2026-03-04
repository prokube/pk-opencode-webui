import { Show, createMemo } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import { Spinner } from "./ui/spinner"
import { useLayout } from "../context/layout"
import { useProviders } from "../context/providers"
import { useMCP } from "../context/mcp"
import { usePermission } from "../context/permission"
import { useTerminal } from "../context/terminal"
import { useSDK } from "../context/sdk"
import { PanelBottom, FileCode, ListTodo, Plug, ArrowLeft, Users } from "lucide-solid"
import { base64Encode } from "../utils/path"
import { PrButton } from "./pr-button"
import type { Session } from "../sdk/client"

interface SessionHeaderProps {
  session: Session | null | undefined
  processing: boolean
  onOpenMCPDialog: () => void
  onSendPrompt: (prompt: string) => void
}

export function SessionHeader(props: SessionHeaderProps) {
  const layout = useLayout()
  const providers = useProviders()
  const mcp = useMCP()
  const permission = usePermission()
  const terminal = useTerminal()
  const { directory } = useSDK()
  const navigate = useNavigate()
  const params = useParams<{ dir: string }>()

  const dirSlug = createMemo(() => (directory ? base64Encode(directory) : params.dir))
  const parentId = () => props.session?.parentID

  function navigateToParent() {
    const id = parentId()
    if (!id) return
    navigate(`/${dirSlug()}/session/${id}`)
  }

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
            <h1 class="text-sm font-medium truncate" style={{ color: "var(--text-strong)" }}>
              {props.session?.title || "New Session"}
            </h1>
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

      {/* Right side: PR button + panel toggles */}
      <div class="flex items-center gap-2">
        <PrButton onSendPrompt={props.onSendPrompt} />
      </div>

      <div class="flex items-center gap-1">
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
    </header>
  )
}
