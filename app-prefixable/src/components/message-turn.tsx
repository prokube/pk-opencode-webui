import { type Accessor, createSignal, createEffect, Show, For, createMemo, onCleanup } from "solid-js"
import { ChevronDown, ChevronRight, User, Bot, FileText, Copy, Check, Clock, ExternalLink } from "lucide-solid"
import { Markdown } from "./markdown"
import { MessageParts } from "./tool-part"
import { ImagePreview } from "./image-preview"
import { errorText } from "../types/message"
import type { DisplayMessage, Turn } from "../types/message"
import type { Part, Session } from "../sdk/client"
import { extractTextContent } from "../utils/message"
import { formatRelativeTime, formatAbsoluteTime, formatDuration } from "../utils/time"
import { useNavigate, useParams } from "@solidjs/router"
import { useSync } from "../context/sync"
import { useSDK } from "../context/sdk"
import { base64Encode } from "../utils/path"

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

function isAgentPart(p: Part): p is Extract<Part, { type: "agent" }> {
  return p.type === "agent"
}

function isSnapshotPart(p: Part): p is Extract<Part, { type: "snapshot" }> {
  return p.type === "snapshot"
}

function isRetryPart(p: Part): p is Extract<Part, { type: "retry" }> {
  return p.type === "retry"
}

function isPatchPart(p: Part): p is Extract<Part, { type: "patch" }> {
  return p.type === "patch"
}

function isSubtaskPart(p: Part): p is Extract<Part, { type: "subtask" }> {
  return p.type === "subtask"
}

const MAX_SHARED_CHILDREN = 400
const MAX_SHARED_CHILDREN_INFLIGHT = 200
const MAX_SHARED_SYNCED_CHILDREN = 600
const CHILDREN_RETRY_DELAY_MS = 5000
const CHILDREN_EMPTY_RETRY_DELAY_MS = 1500
const CHILDREN_EMPTY_RETRY_MAX_DELAY_MS = 30000
const MAX_SHARED_CHILDREN_RETRY = 400

function childCacheKey(sessionID: string, directory: string | undefined) {
  return `${directory ?? ""}::${sessionID}`
}

function lruGet<V>(map: Map<string, V>, key: string) {
  const value = map.get(key)
  if (value === undefined) return undefined
  map.delete(key)
  map.set(key, value)
  return value
}

function lruSet<V>(map: Map<string, V>, key: string, value: V, max: number) {
  if (map.has(key)) map.delete(key)
  map.set(key, value)
  if (map.size <= max) return
  const oldest = map.keys().next().value
  if (oldest === undefined) return
  map.delete(oldest)
}

function lruHas(set: Set<string>, value: string) {
  if (!set.has(value)) return false
  set.delete(value)
  set.add(value)
  return true
}

function lruAdd(set: Set<string>, value: string, max: number) {
  if (set.has(value)) set.delete(value)
  set.add(value)
  if (set.size <= max) return
  const oldest = set.values().next().value
  if (oldest === undefined) return
  set.delete(oldest)
}

const sharedChildren = new Map<string, Session[]>()
const sharedChildrenInflight = new Map<string, Promise<Session[]>>()
const sharedChildrenEmptyBackoff = new Map<string, number>()
const sharedChildrenRetryAt = new Map<string, number>()
const sharedSyncedChildren = new Set<string>()

function renderMetaPart(part: Part) {
  if (isAgentPart(part)) {
    const source = part.source?.value?.trim()
    return (
      <div
        class="inline-flex items-center gap-2 rounded-full px-2 py-1 text-xs max-w-full"
        style={{
          background: "var(--surface-inset)",
          color: "var(--text-base)",
          border: "1px solid var(--border-base)",
        }}
        title={source ? `Source: ${source}` : undefined}
        aria-label={source ? `Agent ${part.name} from ${source}` : `Agent ${part.name}`}
      >
        <span>Agent: {part.name || "unknown"}</span>
        <Show when={source}>
          <span class="font-mono truncate" style={{ color: "var(--text-weak)", "max-width": "22ch" }}>
            {source}
          </span>
        </Show>
      </div>
    )
  }
  if (isSnapshotPart(part)) {
    return (
      <div class="flex items-center gap-2" aria-label={`Snapshot ${part.snapshot.slice(0, 8)}`}>
        <div class="h-px flex-1" style={{ background: "var(--border-base)" }} />
        <span class="text-[11px] uppercase tracking-wide" style={{ color: "var(--text-weak)" }}>
          Snapshot {part.snapshot.slice(0, 8)}
        </span>
        <div class="h-px flex-1" style={{ background: "var(--border-base)" }} />
      </div>
    )
  }
  if (isRetryPart(part)) {
    return (
      <div
        class="px-3 py-2 rounded text-sm"
        style={{
          background: "var(--surface-inset)",
          color: "var(--icon-warning-base)",
          border: "1px solid var(--border-base)",
        }}
      >
        <div class="font-medium">Retry attempt {part.attempt}</div>
        <div>{errorText(part.error)}</div>
        <div class="text-xs mt-1" style={{ color: "var(--text-weak)" }}>
          {formatAbsoluteTime(part.time.created)}
        </div>
      </div>
    )
  }
  if (isPatchPart(part)) {
    const count = part.files.length
    return (
      <details
        class="rounded"
        style={{ border: "1px solid var(--border-base)", background: "var(--surface-inset)" }}
        aria-label={`Patch ${part.hash.slice(0, 8)} with ${count} affected file${count === 1 ? "" : "s"}`}
      >
        <summary class="px-3 py-2 text-sm cursor-pointer" style={{ color: "var(--text-base)" }}>
          Patch {part.hash.slice(0, 8)} · {count} file{count === 1 ? "" : "s"}
        </summary>
        <Show
          when={count > 0}
          fallback={<div class="px-3 pb-2 text-xs" style={{ color: "var(--text-weak)" }}>No files reported</div>}
        >
          <ul class="px-3 pb-2 text-xs space-y-1" style={{ color: "var(--text-weak)" }}>
            <For each={part.files}>
              {(file) => <li class="font-mono">{file}</li>}
            </For>
          </ul>
        </Show>
      </details>
    )
  }
  return null
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
      if (part.state.status !== "completed") continue
      const time = part.state.time
      if (time.start == null || time.end == null) continue
      const title = part.state.title ?? part.tool
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
      <Show when={user().time?.created != null}>
        <div class="flex justify-between">
          <span>Sent</span>
          <span style={{ color: "var(--text-base)" }}>{formatAbsoluteTime(user().time!.created)}</span>
        </div>
      </Show>

      {/* Response time range */}
      <Show when={first()?.time?.created != null}>
        <div class="flex justify-between">
          <span>Response</span>
          <span style={{ color: "var(--text-base)" }}>
            {formatAbsoluteTime(first()!.time!.created)}
            <Show when={last()?.time?.completed != null} fallback={<span class="opacity-60"> → in progress...</span>}>
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
            {turnTime()?.duration != null ? formatDuration(turnTime()!.duration!) : "in progress..."}
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
                <span class="flex-1 min-w-0 truncate" style={{ color: "var(--text-base)" }}>{tool.name}</span>
                <span class="shrink-0 ml-2">{formatDuration(tool.duration)}</span>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

function SubtaskCard(props: {
  part: Extract<Part, { type: "subtask" }>
  child?: Session
  state: "waiting" | "running" | "open"
  onOpen: (childID: string) => void
}) {
  const clickable = () => !!props.child?.id
  const title = () => {
    if (!clickable()) return "Waiting for delegated session link"
    if (props.state === "running") return "Open delegated session (still running)"
    return "Open delegated session"
  }

  return (
    <button
      type="button"
      onClick={() => props.child?.id && props.onOpen(props.child.id)}
      class="w-full text-left rounded-md px-3 py-2 transition-colors"
      style={{
        border: "1px solid var(--border-base)",
        background: "var(--background-base)",
        cursor: clickable() ? "pointer" : "default",
      }}
      onMouseEnter={(e) => {
        if (!clickable()) return
        e.currentTarget.style.background = "var(--surface-inset)"
      }}
      onMouseLeave={(e) => {
        if (!clickable()) return
        e.currentTarget.style.background = "var(--background-base)"
      }}
      title={title()}
      aria-label={`Delegated subtask for ${props.part.agent} (${props.state})`}
      disabled={!clickable()}
    >
      <div class="flex items-start gap-2">
        <span
          class="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap"
          style={{
            background: "var(--surface-brand-muted)",
            color: "var(--text-interactive-base)",
            border: "1px solid var(--border-base)",
          }}
        >
          {props.part.agent}
        </span>
        <div class="flex-1 min-w-0 text-sm" style={{ color: "var(--text-base)" }}>
          {props.part.description || props.part.prompt}
        </div>
        <div class="shrink-0 flex items-center gap-1 text-xs" style={{ color: "var(--text-weak)" }}>
          <Show when={props.state === "running"}>
            <span class="w-3 h-3 rounded-full border-2 border-current border-r-transparent animate-spin" />
            <span>running</span>
          </Show>
          <Show when={props.state === "open"}>
            <ExternalLink class="w-3 h-3" />
            <span>open</span>
          </Show>
          <Show when={props.state === "waiting"}>
            <span>waiting</span>
          </Show>
        </div>
      </div>
    </button>
  )
}

export function MessageTurn(props: {
  turn: Turn
  now: Accessor<number>
  defaultExpanded?: boolean
  isLast?: boolean
  onToggle?: (turnId: string, expanded: boolean) => void
}) {
  const sync = useSync()
  const { client, directory } = useSDK()
  const params = useParams<{ dir: string }>()
  const navigate = useNavigate()
  const [expanded, setExpanded] = createSignal(props.defaultExpanded ?? props.isLast ?? false)
  const [previewUrl, setPreviewUrl] = createSignal<string | null>(null)
  const [textExpanded, setTextExpanded] = createSignal(false)
  const [canExpand, setCanExpand] = createSignal(false)
  const [copied, setCopied] = createSignal(false)
  const [focused, setFocused] = createSignal(false)
  const [detailsOpen, setDetailsOpen] = createSignal(false)
  const [hovered, setHovered] = createSignal(false)
  const [children, setChildren] = createSignal<Record<string, Session[]>>({})
  const [childRetry, setChildRetry] = createSignal(0)

  const dirSlug = createMemo(() => (directory ? base64Encode(directory) : params.dir))

  const openChild = (childID: string) => {
    navigate(`/${dirSlug()}/session/${childID}`)
  }

  // Relative timestamp driven by shared `now` signal from parent
  const relativeTime = createMemo(() => {
    const created = props.turn.userMessage.time?.created
    if (created == null) return undefined
    return formatRelativeTime(created, props.now())
  })

  const absoluteTime = createMemo(() => {
    const created = props.turn.userMessage.time?.created
    if (created == null) return undefined
    return formatAbsoluteTime(created)
  })

  // Ref for text overflow detection
  let textRef: HTMLDivElement | undefined
  let copyTimeoutId: ReturnType<typeof setTimeout> | undefined
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>()

  // Cleanup timeout on unmount
  onCleanup(() => {
    if (copyTimeoutId) clearTimeout(copyTimeoutId)
    for (const timer of retryTimers.values()) clearTimeout(timer)
    retryTimers.clear()
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

  const parentIDs = createMemo(() => {
    const ids = new Set<string>()
    for (const message of props.turn.assistantMessages) {
      for (const part of message.parts) {
        if (!isSubtaskPart(part)) continue
        ids.add(part.sessionID)
      }
    }
    return [...ids]
  })

  createEffect(() => {
    childRetry()
    for (const sessionID of parentIDs()) {
      const key = childCacheKey(sessionID, directory)
      const known = children()[sessionID]
      const expected = subtasksForParent(sessionID).length
      if (known && known.length >= expected) continue
      const now = Date.now()
      const retryAt = lruGet(sharedChildrenRetryAt, key)
      if (retryAt !== undefined && retryAt > now) {
        if (!retryTimers.has(key)) {
          const timer = setTimeout(() => {
            retryTimers.delete(key)
            setChildRetry((n) => n + 1)
          }, retryAt - now)
          retryTimers.set(key, timer)
        }
        continue
      }
      if (retryAt !== undefined) {
        sharedChildrenRetryAt.delete(key)
      }
      const cached = lruGet(sharedChildren, key)
      if (cached !== undefined) {
        if (cached.length >= expected) {
          setChildren((prev) => ({ ...prev, [sessionID]: cached }))
          continue
        }
      }
      const inflight = lruGet(sharedChildrenInflight, key)
      if (inflight !== undefined) {
        inflight.then((list) => {
          setChildren((prev) => {
            if (list.length === 0) return prev
            if ((prev[sessionID]?.length ?? 0) >= list.length) return prev
            return { ...prev, [sessionID]: list }
          })
        }).catch(() => {})
        continue
      }

      const pending = client.session
        .children({ sessionID, directory })
        .then((res) => {
          const list = (res.data ?? []).slice().sort((a, b) => a.time.created - b.time.created)
          const needed = subtasksForParent(sessionID).length
          const retryTimer = retryTimers.get(key)
          if (retryTimer) {
            clearTimeout(retryTimer)
            retryTimers.delete(key)
          }
          if (list.length >= needed) {
            sharedChildrenEmptyBackoff.delete(key)
            sharedChildrenRetryAt.delete(key)
            lruSet(sharedChildren, key, list, MAX_SHARED_CHILDREN)
            return list
          }
          const previousDelay = lruGet(sharedChildrenEmptyBackoff, key)
          const delay = previousDelay
            ? Math.min(previousDelay * 2, CHILDREN_EMPTY_RETRY_MAX_DELAY_MS)
            : CHILDREN_EMPTY_RETRY_DELAY_MS
          lruSet(sharedChildrenEmptyBackoff, key, delay, MAX_SHARED_CHILDREN_RETRY)
          lruSet(sharedChildrenRetryAt, key, Date.now() + delay, MAX_SHARED_CHILDREN_RETRY)
          const timer = setTimeout(() => {
            retryTimers.delete(key)
            setChildRetry((n) => n + 1)
          }, delay)
          retryTimers.set(key, timer)
          return list
        })
        .catch((error) => {
          console.error("Failed to load session children", error)
          const retryTimer = retryTimers.get(key)
          if (retryTimer) clearTimeout(retryTimer)
          const timer = setTimeout(() => {
            retryTimers.delete(key)
            setChildRetry((n) => n + 1)
          }, CHILDREN_RETRY_DELAY_MS)
          retryTimers.set(key, timer)
          throw error
        })
        .finally(() => {
          sharedChildrenInflight.delete(key)
        })

      lruSet(sharedChildrenInflight, key, pending, MAX_SHARED_CHILDREN_INFLIGHT)
      pending.then((list) => {
        if (list.length === 0) return
        setChildren((prev) => {
          if ((prev[sessionID]?.length ?? 0) >= list.length) return prev
          return { ...prev, [sessionID]: list }
        })
      }).catch(() => {})
    }
  })

  function subtasksForParent(sessionID: string) {
    const all = sync.messages(sessionID).flatMap((message) => message.parts.filter(isSubtaskPart))
    if (all.length > 0) return all
    return props.turn.assistantMessages
      .flatMap((message) => message.parts.filter(isSubtaskPart))
      .filter((part) => part.sessionID === sessionID)
  }

  const childForSubtask = (part: Extract<Part, { type: "subtask" }>) => {
    const list = children()[part.sessionID]
    if (!list || list.length === 0) return undefined
    const all = subtasksForParent(part.sessionID)
    if (all.length !== list.length) return undefined
    const index = all.findIndex((candidate) => candidate.id === part.id)
    if (index < 0) return undefined
    return list[index]
  }

  createEffect(() => {
    const ids = new Set<string>()
    for (const message of props.turn.assistantMessages) {
      for (const part of message.parts) {
        if (!isSubtaskPart(part)) continue
        const child = childForSubtask(part)
        if (!child?.id) continue
        ids.add(child.id)
      }
    }
    for (const childID of ids) {
      const key = childCacheKey(childID, directory)
      if (lruHas(sharedSyncedChildren, key)) continue
      lruAdd(sharedSyncedChildren, key, MAX_SHARED_SYNCED_CHILDREN)
      void sync.session.sync(childID)
    }
  })

  const childState = (childID: string | undefined) => {
    if (!childID) return "waiting"
    const messages = sync.messages(childID)
    for (let i = messages.length - 1; i >= 0; i--) {
      const info = messages[i].info
      if (info.role !== "assistant") continue
      if (info.time.completed == null) return "running"
      return "open"
    }
    return "running"
  }

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

        {/* Details toggle button — shown when any detail fields are available */}
        <Show when={props.turn.userMessage.time?.created != null || props.turn.assistantMessages.length > 0}>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              setDetailsOpen(!detailsOpen())
            }}
            class="shrink-0 p-1 rounded transition-colors"
            style={{ color: detailsOpen() || hovered() ? "var(--text-strong)" : "var(--icon-weak)" }}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
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
              const meta = () => message.parts.filter((part) => isAgentPart(part) || isSnapshotPart(part) || isRetryPart(part) || isPatchPart(part))
              const subtasks = () => message.parts.filter(isSubtaskPart)

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
                          <strong>Error:</strong> {errorText(err())}
                        </div>
                      )}
                    </Show>
                    {/* Text content */}
                    <Show when={text}>
                      <Markdown content={text} class="text-sm" />
                    </Show>
                    {/* Agent, snapshot, retry, and patch parts */}
                    <Show when={meta().length > 0}>
                      <div class="space-y-2 mt-2">
                        <For each={meta()}>{(part) => renderMetaPart(part)}</For>
                      </div>
                    </Show>
                    <Show when={subtasks().length > 0}>
                      <div class="space-y-2 mt-2">
                        <For each={subtasks()}>
                          {(part) => {
                            const child = createMemo(() => childForSubtask(part))
                            const state = createMemo(() => childState(child()?.id))
                            return (
                              <SubtaskCard
                                part={part}
                                child={child()}
                                state={state()}
                                onOpen={openChild}
                              />
                            )
                          }}
                        </For>
                      </div>
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
