import { type Accessor, createSignal, createEffect, Show, For, createMemo, onCleanup } from "solid-js"
import { ChevronDown, ChevronRight, User, Bot, FileText, Copy, Check, Clock } from "lucide-solid"
import { Markdown } from "./markdown"
import { MessageParts } from "./tool-part"
import { ImagePreview } from "./image-preview"
import type { DisplayMessage, Turn } from "../types/message"
import type { Part, ToolState } from "../sdk/client"
import { extractTextContent } from "../utils/message"
import { formatRelativeTime, formatAbsoluteTime, formatDuration } from "../utils/time"

// Type for file parts with image/PDF data
interface FilePart {
  type: "file"
  mime: string
  url: string
  filename?: string
}

function isFilePart(p: Part): p is Part & FilePart {
  return p.type === "file" && "mime" in p && "url" in p
}

function isImageOrPdf(file: FilePart): boolean {
  return file.mime.startsWith("image/") || file.mime === "application/pdf"
}

// Re-export Turn type for convenience
export type { Turn, DisplayMessage }

function hasTools(message: DisplayMessage): boolean {
  return message.parts.some((p) => p.type === "tool")
}

// Extract completed tool parts with timing from all assistant messages
function extractToolTimings(messages: DisplayMessage[]): { name: string; duration: number }[] {
  const results: { name: string; duration: number }[] = []
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type !== "tool") continue
      const state = (part as { state: ToolState }).state
      if (state.status !== "completed") continue
      const time = state.time
      if (time.start == null || time.end == null) continue
      const title = (state as { title?: string }).title || (part as { tool: string }).tool
      results.push({ name: title, duration: time.end - time.start })
    }
  }
  return results
}

function TurnDetails(props: { turn: Turn }) {
  const user = () => props.turn.userMessage
  const assistants = () => props.turn.assistantMessages
  const first = () => assistants()[0]
  const last = () => assistants()[assistants().length - 1]
  const turnTime = () => props.turn.time
  const inProgress = () => assistants().length === 0 || !last()?.time?.completed

  const toolTimings = createMemo(() => extractToolTimings(assistants()))

  const fmt = (n: number) => n.toLocaleString()

  return (
    <div
      class="px-4 py-2 text-xs font-mono space-y-1"
      style={{
        "border-top": "1px solid var(--border-base)",
        background: "var(--surface-inset)",
        color: "var(--text-weak)",
      }}
    >
      {/* Sent time */}
      <Show when={user().time?.created}>
        <div class="flex justify-between">
          <span>Sent</span>
          <span style={{ color: "var(--text-base)" }}>{formatAbsoluteTime(user().time!.created)}</span>
        </div>
      </Show>

      {/* Response time range */}
      <Show when={first()?.time?.created}>
        <div class="flex justify-between">
          <span>Response</span>
          <span style={{ color: "var(--text-base)" }}>
            {formatAbsoluteTime(first()!.time!.created)}
            <Show when={last()?.time?.completed} fallback={<span class="opacity-60"> → in progress...</span>}>
              <span> → {formatAbsoluteTime(last()!.time!.completed!)}</span>
            </Show>
          </span>
        </div>
      </Show>

      {/* Duration */}
      <Show when={turnTime()}>
        <div class="flex justify-between">
          <span>Duration</span>
          <span style={{ color: "var(--text-base)" }}>
            {inProgress() ? "in progress..." : formatDuration(turnTime()!.duration!)}
          </span>
        </div>
      </Show>

      {/* Model */}
      <Show when={last()?.providerID || last()?.modelID}>
        <div class="flex justify-between">
          <span>Model</span>
          <span style={{ color: "var(--text-base)" }}>
            {[last()?.providerID, last()?.modelID].filter(Boolean).join(" / ")}
          </span>
        </div>
      </Show>

      {/* Tokens */}
      <Show when={last()?.tokens}>
        {(tokens) => (
          <>
            <div class="flex justify-between">
              <span>Tokens</span>
              <span style={{ color: "var(--text-base)" }}>
                in: {fmt(tokens().input)} · out: {fmt(tokens().output)}
              </span>
            </div>
            <Show when={tokens().cache.read > 0 || tokens().cache.write > 0}>
              <div class="flex justify-between pl-4">
                <span />
                <span class="opacity-80">
                  cache read: {fmt(tokens().cache.read)} · write: {fmt(tokens().cache.write)}
                </span>
              </div>
            </Show>
            <Show when={tokens().reasoning > 0}>
              <div class="flex justify-between pl-4">
                <span />
                <span class="opacity-80">reasoning: {fmt(tokens().reasoning)}</span>
              </div>
            </Show>
          </>
        )}
      </Show>

      {/* Tool timings */}
      <Show when={toolTimings().length > 0}>
        <div
          class="pt-1 mt-1 space-y-0.5"
          style={{ "border-top": "1px solid var(--border-base)" }}
        >
          <div>Tools</div>
          <For each={toolTimings()}>
            {(tool) => (
              <div class="flex justify-between pl-4">
                <span class="truncate" style={{ color: "var(--text-base)" }}>{tool.name}</span>
                <span class="shrink-0 ml-2">{formatDuration(tool.duration)}</span>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

export function MessageTurn(props: {
  turn: Turn
  now: Accessor<number>
  defaultExpanded?: boolean
  isLast?: boolean
  onToggle?: (turnId: string, expanded: boolean) => void
}) {
  const [expanded, setExpanded] = createSignal(props.defaultExpanded ?? props.isLast ?? false)
  const [previewUrl, setPreviewUrl] = createSignal<string | null>(null)
  const [textExpanded, setTextExpanded] = createSignal(false)
  const [canExpand, setCanExpand] = createSignal(false)
  const [copied, setCopied] = createSignal(false)
  const [focused, setFocused] = createSignal(false)
  const [detailsOpen, setDetailsOpen] = createSignal(false)

  // Relative timestamp driven by shared `now` signal from parent
  const relativeTime = createMemo(() => {
    const created = props.turn.userMessage.time?.created
    if (!created) return undefined
    return formatRelativeTime(created, props.now())
  })

  const absoluteTime = createMemo(() => {
    const created = props.turn.userMessage.time?.created
    if (!created) return undefined
    return formatAbsoluteTime(created)
  })

  // Ref for text overflow detection
  let textRef: HTMLDivElement | undefined
  let copyTimeoutId: ReturnType<typeof setTimeout> | undefined

  // Cleanup timeout on unmount
  onCleanup(() => {
    if (copyTimeoutId) clearTimeout(copyTimeoutId)
  })

  // Extract image/PDF attachments from user message (single pass)
  const attachments = createMemo(() =>
    props.turn.userMessage.parts.filter((p): p is Part & FilePart => isFilePart(p) && isImageOrPdf(p)),
  )

  // Sync local expanded state with props when defaultExpanded changes
  createEffect(() => {
    const defaultVal = props.defaultExpanded ?? props.isLast ?? false
    setExpanded(defaultVal)
  })

  const userText = createMemo(() => extractTextContent(props.turn.userMessage.parts).trim())

  // Detect text overflow for expand/collapse
  createEffect(() => {
    userText() // Track dependency
    expanded() // Also track turn expansion state
    // Check after render
    requestAnimationFrame(() => {
      if (!textRef) return
      setCanExpand(textRef.scrollHeight > textRef.clientHeight + 2)
    })
  })

  const copy = async () => {
    const text = userText()
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
    } catch (error) {
      console.error("Failed to copy text to clipboard", error)
      return
    }
    setCopied(true)
    if (copyTimeoutId) clearTimeout(copyTimeoutId)
    copyTimeoutId = setTimeout(() => setCopied(false), 2000)
  }

  const assistantText = createMemo(() => {
    const msgs = props.turn.assistantMessages
    if (msgs.length === 0) return ""
    // Get text from last assistant message
    for (let i = msgs.length - 1; i >= 0; i--) {
      const text = extractTextContent(msgs[i].parts).trim()
      if (text) return text
    }
    return ""
  })

  const hasError = createMemo(() => props.turn.assistantMessages.some((m) => m.error))

  const toolCount = createMemo(() => {
    let count = 0
    for (const msg of props.turn.assistantMessages) {
      count += msg.parts.filter((p) => p.type === "tool").length
    }
    return count
  })

  const toggle = () => {
    const next = !expanded()
    setExpanded(next)
    props.onToggle?.(props.turn.id, next)
  }

  return (
    <div
      class="rounded-lg overflow-hidden"
      style={{
        border: "1px solid var(--border-base)",
        background: "var(--background-base)",
      }}
    >
      {/* Turn header */}
      <div
        class="flex items-start gap-3 px-4 py-3 transition-colors group"
        style={{
          background: expanded() ? "var(--surface-inset)" : "transparent",
        }}
        onFocusIn={() => setFocused(true)}
        onFocusOut={() => setFocused(false)}
      >
        {/* User icon */}
        <div class="w-8 h-8 rounded-full flex items-center justify-center shrink-0" style={{ background: "var(--surface-brand-muted)" }}>
          <User class="w-4 h-4 text-brand-600" />
        </div>

        {/* User message preview */}
        <div class="flex-1 min-w-0">
          {/* Text with expand/collapse */}
          <div class="relative">
            <div
              ref={textRef}
              class="text-sm font-medium whitespace-pre-wrap break-words overflow-hidden"
              style={{
                color: "var(--text-strong)",
                "max-height": textExpanded() ? "none" : "64px",
              }}
            >
              {userText() || "(empty message)"}
            </div>
            {/* Gradient fade when collapsed and can expand */}
            <Show when={canExpand() && !textExpanded()}>
              <div
                class="absolute bottom-0 left-0 right-0 h-6 pointer-events-none"
                style={{
                  background: expanded()
                    ? "linear-gradient(to bottom, transparent, var(--surface-inset))"
                    : "linear-gradient(to bottom, transparent, var(--background-base))",
                }}
              />
            </Show>
          </div>
          {/* Expand/collapse text toggle */}
          <Show when={canExpand()}>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                setTextExpanded(!textExpanded())
              }}
              class="flex items-center gap-1 text-xs mt-1 transition-colors"
              style={{ color: "var(--text-weak)" }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text-strong)")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-weak)")}
              aria-label={textExpanded() ? "Collapse user prompt" : "Expand user prompt"}
              aria-expanded={textExpanded()}
            >
              <ChevronRight
                class="w-3 h-3 transition-transform"
                style={{ transform: textExpanded() ? "rotate(90deg)" : "rotate(0deg)" }}
              />
              <span>{textExpanded() ? "Show less" : "Show more"}</span>
            </button>
          </Show>
          {/* Status line */}
          <div class="flex items-center gap-2 text-xs mt-1" style={{ color: "var(--text-weak)" }}>
            <Show when={attachments().length > 0}>
              <span>
                {attachments().length} attachment{attachments().length > 1 ? "s" : ""}
              </span>
              <span>·</span>
            </Show>
            <Show when={toolCount() > 0}>
              <span>
                {toolCount()} tool{toolCount() > 1 ? "s" : ""}
              </span>
              <span>·</span>
            </Show>
            <Show when={hasError()}>
              <span style={{ color: "var(--icon-critical-base)" }}>error</span>
              <span>·</span>
            </Show>
            <span>{props.turn.assistantMessages.length > 0 ? "completed" : "pending"}</span>
          </div>
        </div>

        {/* Relative timestamp */}
        <Show when={relativeTime()}>
          <span
            class="shrink-0 text-xs mt-1"
            style={{ color: "var(--text-weak)" }}
            title={absoluteTime()}
          >
            {relativeTime()}
          </span>
        </Show>

        {/* Details toggle button */}
        <Show when={props.turn.userMessage.time?.created}>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              setDetailsOpen(!detailsOpen())
            }}
            class="shrink-0 p-1 rounded transition-colors"
            style={{ color: detailsOpen() ? "var(--text-strong)" : "var(--icon-weak)" }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text-strong)")}
            onMouseLeave={(e) => {
              if (!detailsOpen()) e.currentTarget.style.color = "var(--icon-weak)"
            }}
            title="Turn details"
            aria-label={detailsOpen() ? "Hide turn details" : "Show turn details"}
            aria-expanded={detailsOpen()}
          >
            <Clock class="w-4 h-4" />
          </button>
        </Show>

        {/* Copy button (appears on hover or focus) */}
        <Show when={userText()}>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              copy()
            }}
            class="shrink-0 p-1.5 rounded transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
            classList={{ "opacity-100": focused() || copied() }}
            style={{
              background: "var(--surface-inset)",
              color: copied() ? "var(--status-success-text)" : "var(--icon-weak)",
            }}
            title={copied() ? "Copied!" : "Copy prompt"}
            aria-label={copied() ? "Copied!" : "Copy prompt"}
          >
            <Show when={copied()} fallback={<Copy class="w-4 h-4" />}>
              <Check class="w-4 h-4" />
            </Show>
          </button>
        </Show>

        {/* Expand indicator (turn expand/collapse) */}
        <button
          type="button"
          onClick={toggle}
          aria-expanded={expanded()}
          aria-label={expanded() ? "Collapse conversation turn" : "Expand conversation turn"}
          class="shrink-0 p-1 rounded transition-colors"
          style={{ color: "var(--icon-weak)" }}
          onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text-strong)")}
          onMouseLeave={(e) => (e.currentTarget.style.color = "var(--icon-weak)")}
        >
          <ChevronDown
            class="w-5 h-5 transition-transform"
            style={{ transform: expanded() ? "rotate(180deg)" : "rotate(0deg)" }}
          />
        </button>
      </div>

      {/* Details panel */}
      <Show when={detailsOpen()}>
        <TurnDetails turn={props.turn} />
      </Show>

      {/* Expanded content */}
      <Show when={expanded()}>
        <div
          class="px-4 py-3 space-y-4"
          style={{
            "border-top": "1px solid var(--border-base)",
            background: "var(--background-stronger)",
          }}
        >
          {/* Attachments only (user text is in header, not repeated here) */}
          <Show when={attachments().length > 0}>
            <div class="flex flex-wrap gap-2 mb-2">
              <For each={attachments()}>
                {(file) => {
                  const isImage = file.mime.startsWith("image/")
                  return (
                    <Show
                      when={isImage}
                      fallback={
                        <div
                          class="relative rounded-md overflow-hidden"
                          style={{
                            width: "48px",
                            height: "48px",
                            background: "var(--surface-inset)",
                            border: "1px solid var(--border-base)",
                          }}
                          title={file.filename || "PDF"}
                        >
                          <div class="w-full h-full flex items-center justify-center">
                            <FileText class="w-5 h-5" style={{ color: "var(--icon-weak)" }} />
                          </div>
                        </div>
                      }
                    >
                      <button
                        type="button"
                        onClick={() => setPreviewUrl(file.url)}
                        class="relative rounded-md overflow-hidden transition-opacity hover:opacity-80 focus:outline-none focus:ring-2 focus:ring-offset-1"
                        style={{
                          width: "48px",
                          height: "48px",
                          background: "var(--surface-inset)",
                          border: "1px solid var(--border-base)",
                          cursor: "pointer",
                        }}
                        title={file.filename || "Click to preview"}
                        aria-label={`Preview ${file.filename || "image"}`}
                      >
                        <img
                          src={file.url}
                          alt={file.filename || "Attached image"}
                          class="w-full h-full object-cover"
                          onError={(e) => (e.currentTarget.style.display = "none")}
                        />
                      </button>
                    </Show>
                  )
                }}
              </For>
            </div>
          </Show>

          {/* Assistant messages */}
          <For each={props.turn.assistantMessages}>
            {(message) => {
              const text = extractTextContent(message.parts).trim()
              const tools = hasTools(message)

              return (
                <div class="flex gap-3">
                  <div
                    class="w-6 h-6 rounded-full flex items-center justify-center shrink-0 mt-0.5"
                    style={{ background: "var(--surface-inset)" }}
                  >
                    <Bot class="w-3 h-3" style={{ color: "var(--text-strong)" }} />
                  </div>
                  <div class="flex-1 min-w-0">
                    <div class="text-xs font-medium mb-1" style={{ color: "var(--text-weak)" }}>
                      ASSISTANT
                    </div>
                    {/* Error display */}
                    <Show when={message.error}>
                      {(err) => (
                        <div
                          class="px-3 py-2 rounded text-sm mb-2"
                          style={{ background: "var(--status-danger-dim)", color: "var(--status-danger-text)" }}
                        >
                          <strong>Error:</strong> {err().data?.message || err().name || "Unknown error"}
                        </div>
                      )}
                    </Show>
                    {/* Text content */}
                    <Show when={text}>
                      <Markdown content={text} class="text-sm" />
                    </Show>
                    {/* Tool calls */}
                    <Show when={tools}>
                      <div class="mt-2">
                        <MessageParts parts={message.parts} />
                      </div>
                    </Show>
                  </div>
                </div>
              )
            }}
          </For>

          {/* Show pending state if no assistant messages */}
          <Show when={props.turn.assistantMessages.length === 0}>
            <div class="flex gap-3">
              <div
                class="w-6 h-6 rounded-full flex items-center justify-center shrink-0 mt-0.5"
                style={{ background: "var(--surface-inset)" }}
              >
                <Bot class="w-3 h-3" style={{ color: "var(--text-strong)" }} />
              </div>
              <div class="flex-1 min-w-0">
                <div class="text-xs font-medium mb-1" style={{ color: "var(--text-weak)" }}>
                  ASSISTANT
                </div>
                <div class="text-sm" style={{ color: "var(--text-weak)" }}>
                  Waiting for response...
                </div>
              </div>
            </div>
          </Show>
        </div>
      </Show>

      {/* Image preview modal */}
      <ImagePreview url={previewUrl()} onClose={() => setPreviewUrl(null)} />
    </div>
  )
}
