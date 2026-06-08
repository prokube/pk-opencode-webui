import { createSignal, createMemo, createEffect, For, Show, onMount, onCleanup, untrack } from "solid-js"
import { Spinner } from "./ui/spinner"
import { MessageTurn } from "./message-turn"
// Note: Markdown and MessageParts are used in the FlatMessageList component below
import { Markdown } from "./markdown"
import { MessageParts } from "./tool-part"
import { ChevronUp } from "lucide-solid"
import { errorText } from "../types/message"
import type { DisplayMessage, Turn } from "../types/message"
import { extractTextContent } from "../utils/message"

// Number of turns to render initially and on each "load more"
const TURNS_PER_BATCH = 10
const INITIAL_TURNS = 5
const NEAR_BOTTOM_PX = 10

type TurnRef = {
  id: string
  userId: string
  assistantIds: string[]
}

// Compute turn-level timing from user and assistant message timestamps
function computeTurnTime(user: DisplayMessage, assistants: DisplayMessage[]): Turn["time"] {
  const started = user.time?.created
  if (started == null || !Number.isFinite(started)) return undefined
  // Find the latest completed timestamp among all assistant messages
  const completed = assistants.reduce<number | undefined>((latest, msg) => {
    const c = msg.time?.completed
    if (c == null || !Number.isFinite(c)) return latest
    if (latest == null) return c
    return c > latest ? c : latest
  }, undefined)
  const duration = completed != null && Number.isFinite(completed) ? completed - started : undefined
  return { started, completed, duration }
}

function messagesToTurnRefs(messages: DisplayMessage[]): TurnRef[] {
  const turns: TurnRef[] = []
  let current: TurnRef | null = null

  for (const msg of messages) {
    if (msg.role === "user") {
      if (current) turns.push(current)
      current = {
        id: msg.id,
        userId: msg.id,
        assistantIds: [],
      }
    } else if (msg.role === "assistant" && current) {
      current.assistantIds.push(msg.id)
    } else if (msg.role === "assistant" && !current) {
      console.warn("MessageTimeline: Dropping assistant message before first user message", msg.id)
    }
  }

  if (current) turns.push(current)
  return turns
}

function hasVisibleContent(message: DisplayMessage): boolean {
  if (message.error) return true
  if (message.role === "user") return true
  if (message.parts.some((p) => p.type === "tool")) return true
  return extractTextContent(message.parts).trim().length > 0
}

function hasStructuredContent(message: DisplayMessage): boolean {
  if (message.error) return true
  if (message.role === "user") return true
  return message.parts.some((p) => p.type === "tool" || p.type === "text" || p.type === "reasoning")
}

function timelineStructure(messages: DisplayMessage[]) {
  return messages
    .map((msg) => `${msg.id}:${msg.role}:${msg.error ? 1 : 0}:${msg.parts.map((p) => p.type).join(",")}`)
    .join("|")
}

export function MessageTimeline(props: {
  messages: DisplayMessage[]
  processing: boolean
  loadingHistory: boolean
  onScroll?: (nearBottom: boolean) => void
}) {
  let containerRef: HTMLDivElement | undefined
  let endRef: HTMLDivElement | undefined

  // Shared clock signal for relative timestamps — one timer for all turns
  const [now, setNow] = createSignal(Date.now())
  let tick: number | undefined
  onMount(() => {
    tick = window.setInterval(() => setNow(Date.now()), 30_000)
  })
  onCleanup(() => {
    if (tick !== undefined) clearInterval(tick)
  })

  // Track which turns are expanded
  const [expanded, setExpanded] = createSignal<Record<string, boolean>>({})
  // Track how many turns to render (for lazy loading)
  const [renderCount, setRenderCount] = createSignal(INITIAL_TURNS)
  // Track if user scrolled up
  const [userScrolledUp, setUserScrolledUp] = createSignal(false)
  // Track previous turn IDs for session switch detection
  const [prevTurnIds, setPrevTurnIds] = createSignal<Set<string>>(new Set())
  const structure = createMemo(() => timelineStructure(props.messages))

  const messageById = createMemo(() => {
    const map = new Map<string, DisplayMessage>()
    for (const msg of props.messages) map.set(msg.id, msg)
    return map
  })

  // Convert messages to turn references only when structure changes.
  const turnRefs = createMemo(() => {
    structure()
    const filtered = untrack(() => props.messages).filter(hasStructuredContent)
    return messagesToTurnRefs(filtered)
  })

  function resolveTurn(ref: TurnRef): Turn | undefined {
    const map = messageById()
    const user = map.get(ref.userId)
    if (!user) return undefined
    const assistants = ref.assistantIds.flatMap((id) => map.get(id) ?? [])
    return {
      id: ref.id,
      userMessage: user,
      assistantMessages: assistants,
      time: computeTurnTime(user, assistants),
    }
  }

  // Calculate which turns to render (from the end, most recent first in render order)
  const renderedTurnRefs = createMemo(() => {
    const all = turnRefs()
    const count = Math.min(renderCount(), all.length)
    return all.slice(Math.max(0, all.length - count))
  })

  const renderedTurns = createMemo(() => {
    return renderedTurnRefs().flatMap((ref) => resolveTurn(ref) ?? [])
  })

  // Check if there are more turns to load
  const hasMore = createMemo(() => renderCount() < turnRefs().length)

  // Get the last turn (for showing streaming content)
  const lastTurn = createMemo(() => {
    const all = turnRefs()
    const ref = all[all.length - 1]
    return ref ? resolveTurn(ref) ?? null : null
  })

  // Load more earlier turns with scroll anchoring
  function loadMore() {
    if (!containerRef) {
      setRenderCount((prev) => Math.min(prev + TURNS_PER_BATCH, turnRefs().length))
      return
    }
    // Save scroll position relative to bottom before loading
    const scrollBottom = containerRef.scrollHeight - containerRef.scrollTop
    setRenderCount((prev) => Math.min(prev + TURNS_PER_BATCH, turnRefs().length))
    // Restore scroll position after DOM update
    requestAnimationFrame(() => {
      if (containerRef) {
        containerRef.scrollTop = containerRef.scrollHeight - scrollBottom
      }
    })
  }

  // Expand a turn by default when it's the last one
  // Use functional update to avoid tracking expanded() which would cause infinite recursion
  createEffect(() => {
    const last = lastTurn()
    if (!last) return
    setExpanded((prev) => {
      if (prev[last.id] !== undefined) return prev // Return same ref = no update
      return { ...prev, [last.id]: true }
    })
  })

  // Handle turn toggle
  function handleToggle(turnId: string, isExpanded: boolean) {
    setExpanded((prev) => ({ ...prev, [turnId]: isExpanded }))
  }

  // Check if near bottom
  function isNearBottom(): boolean {
    if (!containerRef) return true
    const { scrollTop, scrollHeight, clientHeight } = containerRef
    return scrollHeight - scrollTop - clientHeight <= NEAR_BOTTOM_PX
  }

  // Handle scroll
  function handleScroll() {
    const nearBottom = isNearBottom()
    setUserScrolledUp(!nearBottom)
    props.onScroll?.(nearBottom)
  }

  // Scroll to bottom
  function scrollToBottom(force = false) {
    if (userScrolledUp() && !force) return
    requestAnimationFrame(() => {
      if (!containerRef) return
      containerRef.scrollTop = containerRef.scrollHeight
    })
  }

  // Auto-scroll when messages change (if not scrolled up)
  createEffect(() => {
    // Track dependencies
    const msgCount = props.messages.length
    const isProcessing = props.processing
    // Scroll to bottom for new content
    scrollToBottom()
  })

  // Scroll to bottom on mount
  onMount(() => {
    setTimeout(() => scrollToBottom(true), 100)
  })

  // Reset render count when session changes (detect by comparing turn IDs)
  createEffect(() => {
    const currentTurns = turnRefs()
    const currentIds = new Set(currentTurns.map((t) => t.id))
    const prevIds = untrack(() => prevTurnIds())

    // Detect session switch: if most previous IDs are not in current set, it's a new session
    if (prevIds.size > 0) {
      let overlap = 0
      for (const id of prevIds) {
        if (currentIds.has(id)) overlap++
      }
      // If less than half of previous IDs exist in current, it's likely a session switch
      if (overlap < prevIds.size / 2) {
        setRenderCount(INITIAL_TURNS)
        setExpanded({})
      }
    }

    // Reset if turns are few
    if (currentTurns.length <= INITIAL_TURNS) {
      setRenderCount(INITIAL_TURNS)
    }

    // Update previous turn IDs
    setPrevTurnIds(currentIds)
  })

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      class="flex-1 overflow-y-auto p-6"
      style={{ background: "var(--background-stronger)" }}
    >
      {/* Loading history indicator */}
      <Show when={props.loadingHistory}>
        <div class="flex flex-col items-center justify-center h-full text-center">
          <Spinner class="w-8 h-8 mb-4" />
          <p class="text-lg" style={{ color: "var(--text-weak)" }}>
            Loading chat history...
          </p>
        </div>
      </Show>

      {/* Main content */}
      <Show when={!props.loadingHistory}>
        {/* Load earlier button */}
        <Show when={hasMore()}>
          <div class="flex justify-center mb-4">
            <button
              onClick={loadMore}
              class="flex items-center gap-2 px-4 py-2 text-sm rounded-lg transition-colors"
              style={{
                background: "var(--surface-inset)",
                color: "var(--text-weak)",
                border: "1px solid var(--border-base)",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--background-base)"
                e.currentTarget.style.color = "var(--text-strong)"
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "var(--surface-inset)"
                e.currentTarget.style.color = "var(--text-weak)"
              }}
            >
              <ChevronUp class="w-4 h-4" />
              <span>Load {Math.min(TURNS_PER_BATCH, turns().length - renderCount())} earlier turns</span>
            </button>
          </div>
        </Show>

        {/* Turns */}
        <div class="space-y-4">
          <For each={renderedTurns()}>
            {(turn, index) => (
              <MessageTurn
                turn={turn}
                now={now}
                isLast={index() === renderedTurns().length - 1}
                defaultExpanded={expanded()[turn.id] ?? index() === renderedTurns().length - 1}
                onToggle={handleToggle}
              />
            )}
          </For>
        </div>

        {/* Processing indicator - shown when processing but last turn has content */}
        <Show when={props.processing && lastTurn() && lastTurn()!.assistantMessages.length > 0}>
          <div class="mt-4">
            <div
              class="rounded-lg p-4"
              style={{
                background: "var(--background-base)",
                border: "1px solid var(--border-base)",
              }}
            >
              <div class="flex items-center gap-2" style={{ color: "var(--text-weak)" }}>
                <Spinner class="w-4 h-4" />
                <span>Thinking...</span>
              </div>
            </div>
          </div>
        </Show>

        {/* Empty state */}
        <Show when={turns().length === 0 && !props.processing}>
          <div class="flex flex-col items-center justify-center h-full text-center py-12">
            <div
              class="w-16 h-16 rounded-full flex items-center justify-center mb-4"
              style={{ background: "var(--surface-inset)" }}
            >
              <svg
                class="w-8 h-8"
                style={{ color: "var(--text-interactive-base)" }}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                />
              </svg>
            </div>
            <p class="text-lg mb-2" style={{ color: "var(--text-weak)" }}>
              Ready to chat
            </p>
            <p style={{ color: "var(--text-weak)", opacity: 0.7 }}>Type a message below to begin</p>
          </div>
        </Show>

        {/* Processing indicator when no turns yet */}
        <Show when={props.processing && (!lastTurn() || lastTurn()!.assistantMessages.length === 0)}>
          <div class="mt-4">
            <div
              class="rounded-lg p-4"
              style={{
                background: "var(--background-base)",
                border: "1px solid var(--border-base)",
              }}
            >
              <div class="flex items-center gap-2" style={{ color: "var(--text-weak)" }}>
                <Spinner class="w-4 h-4" />
                <span>Thinking...</span>
              </div>
            </div>
          </div>
        </Show>
      </Show>

      {/* Scroll anchor */}
      <div ref={endRef} />
    </div>
  )
}

// Flat message list display (alternative simpler view)
export function FlatMessageList(props: { messages: DisplayMessage[]; processing: boolean; loadingHistory: boolean }) {
  let containerRef: HTMLDivElement | undefined
  let endRef: HTMLDivElement | undefined
  const [userScrolledUp, setUserScrolledUp] = createSignal(false)

  function isNearBottom(): boolean {
    if (!containerRef) return true
    const { scrollTop, scrollHeight, clientHeight } = containerRef
    return scrollHeight - scrollTop - clientHeight <= NEAR_BOTTOM_PX
  }

  function handleScroll() {
    setUserScrolledUp(!isNearBottom())
  }

  function scrollToBottom(force = false) {
    if (userScrolledUp() && !force) return
    requestAnimationFrame(() => {
      if (!containerRef) return
      containerRef.scrollTop = containerRef.scrollHeight
    })
  }

  createEffect(() => {
    const msgCount = props.messages.length
    scrollToBottom()
  })

  onMount(() => {
    setTimeout(() => scrollToBottom(true), 100)
  })

  const visibleMessages = createMemo(() => props.messages.filter(hasVisibleContent))

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      class="flex-1 overflow-y-auto p-6 space-y-4"
      style={{ background: "var(--background-stronger)" }}
    >
      <Show when={props.loadingHistory}>
        <div class="flex flex-col items-center justify-center h-full text-center">
          <Spinner class="w-8 h-8 mb-4" />
          <p class="text-lg" style={{ color: "var(--text-weak)" }}>
            Loading chat history...
          </p>
        </div>
      </Show>

      <Show when={!props.loadingHistory}>
        <Show when={visibleMessages().length === 0 && !props.processing}>
          <div class="flex flex-col items-center justify-center h-full text-center py-12">
            <p class="text-lg mb-2" style={{ color: "var(--text-weak)" }}>
              Ready to chat
            </p>
            <p style={{ color: "var(--text-weak)", opacity: 0.7 }}>Type a message below to begin</p>
          </div>
        </Show>

        <For each={visibleMessages()}>
          {(message) => {
            const text = extractTextContent(message.parts).trim()
            const hasText = text.length > 0
            const hasTools = message.parts.some((p) => p.type === "tool")
            const isToolOnly = message.role === "assistant" && !hasText && hasTools && !message.error

            return (
              <div
                class="w-full"
                classList={{
                  "max-w-2xl ml-auto": message.role === "user",
                }}
              >
                <Show when={isToolOnly}>
                  <MessageParts parts={message.parts} />
                </Show>

                <Show when={!isToolOnly}>
                  <div
                    class="rounded-lg p-4"
                    style={{
                      background: message.role === "user" ? "var(--surface-inset)" : "var(--background-base)",
                      border: "1px solid var(--border-base)",
                    }}
                  >
                    <div class="text-xs font-medium mb-2 uppercase tracking-wide" style={{ color: "var(--text-weak)" }}>
                      {message.role}
                    </div>
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
                    <Show
                      when={message.role === "assistant"}
                      fallback={
                        <div class="whitespace-pre-wrap" style={{ color: "var(--text-base)" }}>
                          {text || "..."}
                        </div>
                      }
                    >
                      <Show when={hasText}>
                        <Markdown content={text} class="text-[var(--text-strong)]" />
                      </Show>
                    </Show>
                  </div>
                  <Show when={message.role === "assistant" && hasTools}>
                    <div class="mt-2">
                      <MessageParts parts={message.parts} />
                    </div>
                  </Show>
                </Show>
              </div>
            )
          }}
        </For>

        <Show when={props.processing}>
          <div class="w-full">
            <div
              class="rounded-lg p-4"
              style={{
                background: "var(--background-base)",
                border: "1px solid var(--border-base)",
              }}
            >
              <div class="flex items-center gap-2" style={{ color: "var(--text-weak)" }}>
                <Spinner class="w-4 h-4" />
                <span>Thinking...</span>
              </div>
            </div>
          </div>
        </Show>
      </Show>

      <div ref={endRef} />
    </div>
  )
}
