import { createMemo, createSignal, createEffect, Show, onCleanup } from "solid-js"
import { Portal } from "solid-js/web"
import { useParams } from "@solidjs/router"
import { useSync } from "../context/sync"
import { useProviders } from "../context/providers"
import { getContextTokens } from "../utils/tokens"
import { Zap, CornerDownLeft, Square } from "lucide-solid"

interface SessionInfoProps {
  input: () => string
  loading: () => boolean
  processing: () => boolean
  onAbort: () => void
  onAgentClick: () => void
  onModelClick: () => void
}

export function SessionInfo(props: SessionInfoProps) {
  const params = useParams<{ dir: string; id?: string }>()
  const sync = useSync()
  const providers = useProviders()

  // Sync session data when session ID changes
  createEffect(() => {
    const id = params.id
    if (id) {
      sync.session.sync(id)
    }
  })

  // Get messages from sync context - reactive, no polling needed
  const messages = createMemo(() => {
    const id = params.id
    if (!id) return []
    return sync.messages(id)
  })

  // Calculate token usage from last assistant message and cumulative cost
  const stats = createMemo(() => {
    const msgs = messages()
    if (!msgs.length) return null

    // Calculate cumulative cost across all assistant messages
    let totalCost = 0
    for (const msg of msgs) {
      if (msg.info?.role === "assistant") {
        totalCost += (msg.info as { cost?: number }).cost || 0
      }
    }

    // Type for assistant message info
    type AssistantInfo = {
      tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
      modelID?: string
      providerID?: string
    }

    // Find last assistant message with context tokens (current context state)
    // Context tokens represent context usage - how much of the window is filled
    let lastAssistant: {
      contextTokens: number
      modelID?: string
      providerID?: string
      input: number
      output: number
      reasoning: number
      cacheRead: number
      cacheWrite: number
    } | null = null
    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i]
      if (msg.info?.role !== "assistant") continue
      const info = msg.info as AssistantInfo
      const contextTokens = getContextTokens(info.tokens)
      if (contextTokens > 0) {
        lastAssistant = {
          contextTokens,
          modelID: info.modelID,
          providerID: info.providerID,
          input: info.tokens?.input || 0,
          output: info.tokens?.output || 0,
          reasoning: info.tokens?.reasoning || 0,
          cacheRead: info.tokens?.cache?.read || 0,
          cacheWrite: info.tokens?.cache?.write || 0,
        }
        break
      }
    }

    if (!lastAssistant) return null

    // Get model context limit for usage percentage (use lastAssistant's model, not selectedModel)
    const provider = providers.providers.find((p: { id: string }) => p.id === lastAssistant!.providerID)
    if (!provider && providers.providers.length > 0 && import.meta.env.DEV) {
      console.warn("[session-info] provider not found:", lastAssistant!.providerID,
        "available:", providers.providers.map(p => p.id))
    }
    const model = provider?.models[lastAssistant.modelID ?? ""]
    if (provider && !model && import.meta.env.DEV) {
      console.warn("[session-info] model not found:", lastAssistant.modelID,
        "available:", Object.keys(provider.models))
    }
    const limit = model?.limit?.context ?? 0
    const usage = limit && Number.isFinite(limit) && limit > 0
      ? Math.min(100, Math.max(0, Math.round((lastAssistant.contextTokens / limit) * 100)))
      : null

    return {
      tokens: lastAssistant.contextTokens.toLocaleString(),
      usage,
      cost: new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 4,
      }).format(totalCost),
      // Breakdown fields for the popover
      contextTokens: lastAssistant.contextTokens,
      contextLimit: limit,
      input: lastAssistant.input,
      cacheRead: lastAssistant.cacheRead,
      cacheWrite: lastAssistant.cacheWrite,
      cacheTotal: lastAssistant.cacheRead + lastAssistant.cacheWrite,
      output: lastAssistant.output,
      reasoning: lastAssistant.reasoning,
      totalCost,
    }
  })

  // Resolve friendly model name from providers
  const modelLabel = createMemo(() => {
    const selected = providers.selectedModel
    if (!selected) return null
    const provider = providers.providers.find((p: { id: string }) => p.id === selected.providerID)
    const model = provider?.models[selected.modelID]
    return model?.name || selected.modelID
  })

  // Token popover state — reset when session changes
  const [showTokenPopover, setShowTokenPopover] = createSignal(false)
  createEffect(() => {
    params.id // track session ID
    setShowTokenPopover(false)
  })
  const [popoverPos, setPopoverPos] = createSignal({ top: 0, left: 0 })
  let triggerRef: HTMLButtonElement | undefined
  let popoverRef: HTMLDivElement | undefined

  // Dismiss token popover on click outside or Escape
  createEffect(() => {
    if (!showTokenPopover()) return

    function handleClick(e: MouseEvent) {
      if (popoverRef && !popoverRef.contains(e.target as Node) &&
          triggerRef && !triggerRef.contains(e.target as Node)) {
        setShowTokenPopover(false)
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault()
        e.stopPropagation()
        setShowTokenPopover(false)
      }
    }

    document.addEventListener("mousedown", handleClick)
    document.addEventListener("keydown", handleKey)
    onCleanup(() => {
      document.removeEventListener("mousedown", handleClick)
      document.removeEventListener("keydown", handleKey)
    })
  })

  function togglePopover() {
    if (showTokenPopover()) {
      setShowTokenPopover(false)
      return
    }
    if (triggerRef) {
      const rect = triggerRef.getBoundingClientRect()
      const POPOVER_WIDTH = 256
      const maxLeft = window.innerWidth - POPOVER_WIDTH - 16
      setPopoverPos({ top: rect.top - 8, left: Math.max(0, Math.min(rect.left, maxLeft)) })
    }
    setShowTokenPopover(true)
  }

  const dirSlug = createMemo(() => params.dir)

  const fmt = (n: number) => n.toLocaleString()

  return (
    <div class="flex items-center px-4 py-1.5 text-xs" style={{ color: "var(--text-weak)" }}>
      {/* Left group - info text, truncatable */}
      <div class="flex flex-1 items-center gap-3 min-w-0 overflow-hidden whitespace-nowrap [&_button:focus-visible]:outline-offset-[-2px] [&_a:focus-visible]:outline-offset-[-2px]">
        {/* Agent */}
        <Show when={providers.selectedAgent}>
          <button
            type="button"
            class="flex items-center gap-1 shrink-0 hover:opacity-80 cursor-pointer"
            onClick={() => props.onAgentClick()}
          >
            <span class="opacity-60">Agent:</span>
            <span class="capitalize" style={{ color: "var(--text-base)" }}>
              {providers.selectedAgent}
            </span>
          </button>
        </Show>

        {/* Model */}
        <Show when={providers.selectedModel}>
          <button
            type="button"
            class="flex items-center gap-1 min-w-0 hover:opacity-80 cursor-pointer"
            onClick={() => props.onModelClick()}
          >
            <span class="opacity-60 shrink-0">Model:</span>
            <span class="truncate" style={{ color: "var(--text-base)" }}>{modelLabel()}</span>
          </button>
        </Show>

        {/* Token Usage */}
        <Show when={stats()}>
          {(s) => (
            <div class="flex items-center gap-3">
              <button
                ref={triggerRef}
                type="button"
                class="flex items-center gap-3 hover:opacity-80 cursor-pointer"
                onClick={togglePopover}
                aria-haspopup="true"
                aria-expanded={showTokenPopover()}
              >
                <span class="flex items-center gap-1.5 shrink-0">
                  <Zap class="w-3 h-3" />
                  <span style={{ color: "var(--text-base)" }}>{s().tokens}</span>
                  <span class="opacity-60">tokens</span>
                  <Show when={s().usage !== null}>
                    <span
                      class="px-1 py-0.5 rounded text-[10px] font-medium"
                      style={{
                        background: s().usage! > 80 ? "var(--surface-critical-subtle)" : "var(--surface-inset)",
                        color: s().usage! > 80 ? "var(--text-critical-base)" : "var(--text-weak)",
                      }}
                    >
                      {s().usage}%
                    </span>
                  </Show>
                </span>
                <span class="flex items-center gap-1.5 shrink-0">
                  <span class="opacity-60">Cost:</span>
                  <span style={{ color: "var(--text-base)" }}>{s().cost}</span>
                </span>
              </button>

              {/* Token breakdown popover - portalled to escape overflow-hidden */}
              <Show when={showTokenPopover()}>
                <Portal>
                  <div
                    ref={popoverRef}
                    class="w-64 rounded-lg shadow-lg text-xs"
                    style={{
                      position: "fixed",
                      top: `${popoverPos().top}px`,
                      left: `${popoverPos().left}px`,
                      transform: "translateY(-100%)",
                      "z-index": "9999",
                      background: "var(--background-base)",
                      border: "1px solid var(--border-base)",
                    }}
                  >
                    <div
                      class="px-3 py-2 font-medium"
                      style={{
                        color: "var(--text-strong)",
                        "border-bottom": "1px solid var(--border-base)",
                        background: "var(--surface-inset)",
                        "border-radius": "0.5rem 0.5rem 0 0",
                      }}
                    >
                      Token Breakdown
                    </div>
                    <div class="px-3 py-2 space-y-1.5 font-mono" style={{ color: "var(--text-base)" }}>
                      {/* Context */}
                      <div class="flex justify-between">
                        <span>Context:</span>
                        <span>
                          {fmt(s().contextTokens)}
                          <Show when={s().contextLimit > 0}>
                            <span class="opacity-60"> / {fmt(s().contextLimit)}</span>
                          </Show>
                          <Show when={s().usage !== null}>
                            <span class="opacity-60"> ({s().usage}%)</span>
                          </Show>
                        </span>
                      </div>

                      {/* Input */}
                      <div class="flex justify-between pl-3" style={{ color: "var(--text-weak)" }}>
                        <span>Input:</span>
                        <span>{fmt(s().input)}</span>
                      </div>

                      {/* Cache */}
                      <div class="flex justify-between pl-3" style={{ color: "var(--text-weak)" }}>
                        <span>Cache:</span>
                        <span>{fmt(s().cacheTotal)}</span>
                      </div>
                      <Show when={s().cacheRead > 0 || s().cacheWrite > 0}>
                        <div class="flex justify-between pl-6" style={{ color: "var(--text-weak)", opacity: 0.8 }}>
                          <span>read / write:</span>
                          <span>{fmt(s().cacheRead)} / {fmt(s().cacheWrite)}</span>
                        </div>
                      </Show>

                      {/* Output */}
                      <div class="flex justify-between">
                        <span>Output:</span>
                        <span>{fmt(s().output)}</span>
                      </div>

                      {/* Reasoning */}
                      <Show when={s().reasoning > 0}>
                        <div class="flex justify-between">
                          <span>Reasoning:</span>
                          <span>{fmt(s().reasoning)}</span>
                        </div>
                      </Show>

                      {/* Cost */}
                      <div
                        class="flex justify-between pt-1.5 mt-1"
                        style={{ "border-top": "1px solid var(--border-base)" }}
                      >
                        <span>Cost:</span>
                        <span>{s().cost} <span class="opacity-60" style={{ "font-family": "inherit" }}>(session)</span></span>
                      </div>
                    </div>
                  </div>
                </Portal>
              </Show>
            </div>
          )}
        </Show>

        {/* No provider warning */}
        <Show when={!providers.selectedModel && providers.connected.length === 0}>
          <a href={`/${dirSlug()}/settings`} style={{ color: "var(--text-interactive-base)" }} class="hover:underline">
            Connect a provider to start
          </a>
        </Show>

        <Show when={!providers.selectedModel && providers.connected.length > 0}>
          <span style={{ color: "var(--status-warning-text)" }}>No model selected</span>
        </Show>
      </div>

      {/* Right group - action controls, always visible */}
      <div class="ml-3 flex items-center shrink-0">
        <Show
          when={props.processing()}
          fallback={
            <Show when={props.input().trim() && !props.loading()}>
              <span class="flex items-center gap-1 opacity-50" title="Press Enter to send">
                <span class="font-mono text-[10px] px-1 py-0.5 rounded" style={{ background: "var(--surface-inset)" }}>
                  Enter
                </span>
                <CornerDownLeft class="w-3 h-3" />
              </span>
            </Show>
          }
        >
          <button
            type="button"
            onClick={props.onAbort}
            class="flex items-center gap-1.5 px-2 py-1 rounded transition-colors"
            style={{
              color: "var(--text-critical-base)",
              border: "1px solid var(--border-critical-base)",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-critical-subtle)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            title="Stop generation (Esc Esc)"
          >
            <Square class="w-3 h-3" />
            <span>Stop</span>
          </button>
        </Show>
      </div>
    </div>
  )
}
