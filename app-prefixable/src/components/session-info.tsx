import { createMemo, createSignal, createEffect, Show, onCleanup } from "solid-js"
import { Portal } from "solid-js/web"
import { useParams } from "@solidjs/router"
import { useSync } from "../context/sync"
import { useProviders } from "../context/providers"
import { getContextTokens } from "../utils/tokens"
import { Zap, CornerDownLeft, Square } from "lucide-solid"

interface ModelKey {
  providerID: string
  modelID: string
}

type Tokens = {
  input?: number
  output?: number
  reasoning?: number
  cache?: { read?: number; write?: number }
}

type AssistantMeta = {
  role?: string
  tokens?: Tokens
  modelID?: string
  providerID?: string
  cost?: number
}

type ModelMeta = {
  id?: string
  name?: string
  family?: string
  status?: string
  release_date?: string
  limit?: { context?: number; input?: number; output?: number }
  reasoning?: boolean
  tool_call?: boolean
  attachment?: boolean
  interleaved?: boolean
  modalities?: { input?: string[]; output?: string[] }
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number }
}

function obj(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function num(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined
  return value
}

function str(value: unknown) {
  if (typeof value !== "string") return undefined
  return value
}

function bool(value: unknown) {
  if (typeof value !== "boolean") return undefined
  return value
}

function arr(value: unknown) {
  if (!Array.isArray(value)) return undefined
  return value.filter((x): x is string => typeof x === "string")
}

function assistantMeta(value: unknown): AssistantMeta | undefined {
  const info = obj(value)
  if (!info || info.role !== "assistant") return undefined
  const tokensRaw = obj(info.tokens)
  const cacheRaw = obj(tokensRaw?.cache)
  return {
    role: "assistant",
    modelID: str(info.modelID),
    providerID: str(info.providerID),
    cost: num(info.cost),
    tokens: {
      input: num(tokensRaw?.input),
      output: num(tokensRaw?.output),
      reasoning: num(tokensRaw?.reasoning),
      cache: {
        read: num(cacheRaw?.read),
        write: num(cacheRaw?.write),
      },
    },
  }
}

function modelMeta(value: unknown): ModelMeta | undefined {
  const model = obj(value)
  if (!model) return undefined
  const limit = obj(model.limit)
  const modalities = obj(model.modalities)
  const cost = obj(model.cost)
  return {
    id: str(model.id),
    name: str(model.name),
    family: str(model.family),
    status: str(model.status),
    release_date: str(model.release_date),
    limit: {
      context: num(limit?.context),
      input: num(limit?.input),
      output: num(limit?.output),
    },
    reasoning: bool(model.reasoning),
    tool_call: bool(model.tool_call),
    attachment: bool(model.attachment),
    interleaved: bool(model.interleaved),
    modalities: {
      input: arr(modalities?.input),
      output: arr(modalities?.output),
    },
    cost: {
      input: num(cost?.input),
      output: num(cost?.output),
      cache_read: num(cost?.cache_read),
      cache_write: num(cost?.cache_write),
    },
  }
}

interface SessionInfoProps {
  input: () => string
  loading: () => boolean
  processing: () => boolean
  sessionModel: () => ModelKey | null
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
      const info = assistantMeta(msg.info)
      if (!info) continue
      totalCost += info.cost || 0
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
      const info = assistantMeta(msg.info)
      if (!info) continue
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
    const selected = props.sessionModel()
    if (!selected) return null
    const provider = providers.providers.find((p: { id: string }) => p.id === selected.providerID)
    const model = provider?.models[selected.modelID]
    return model?.name || selected.modelID
  })

  const modelInfo = createMemo(() => {
    const selected = props.sessionModel()
    if (!selected) return null
    const provider = providers.providers.find((p: { id: string }) => p.id === selected.providerID)
    const model = modelMeta(provider?.models[selected.modelID])
    return {
      providerID: selected.providerID,
      providerName: provider?.name || selected.providerID,
      modelID: model?.id || selected.modelID,
      modelName: model?.name || selected.modelID,
      family: model?.family,
      status: model?.status,
      releaseDate: model?.release_date,
      contextLimit: model?.limit?.context,
      inputLimit: model?.limit?.input,
      outputLimit: model?.limit?.output,
      reasoning: model?.reasoning,
      toolCall: model?.tool_call,
      attachment: model?.attachment,
      interleaved: model?.interleaved,
      modalitiesInput: model?.modalities?.input,
      modalitiesOutput: model?.modalities?.output,
      costInput: model?.cost?.input,
      costOutput: model?.cost?.output,
      costCacheRead: model?.cost?.cache_read,
      costCacheWrite: model?.cost?.cache_write,
    }
  })

  const modelCapabilities = createMemo(() => {
    const meta = modelInfo()
    if (!meta) return ""
    const input = meta.modalitiesInput ?? []
    const output = meta.modalitiesOutput ?? []
    const list = [
      meta.reasoning ? "reasoning" : "",
      meta.toolCall ? "tools" : "",
      meta.attachment ? "attachments" : "",
      meta.interleaved ? "interleaved" : "",
      input.includes("image") ? "image input" : "",
      input.includes("audio") ? "audio input" : "",
      input.includes("video") ? "video input" : "",
      input.includes("pdf") ? "pdf input" : "",
      output.includes("image") ? "image output" : "",
      output.includes("audio") ? "audio output" : "",
      output.includes("video") ? "video output" : "",
      output.includes("pdf") ? "pdf output" : "",
    ].filter(Boolean)
    return list.join(", ")
  })

  const fmtMoney = (n: number) => {
    if (!Number.isFinite(n)) return ""
    if (n === 0) return "$0"
    if (n >= 1) return `$${n.toFixed(2)}`
    if (n >= 0.01) return `$${n.toFixed(4)}`
    return `$${n.toPrecision(3)}`
  }

  const fmtDate = (value: string) => {
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return value
    return new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(date)
  }

  const [showModelPopover, setShowModelPopover] = createSignal(false)
  const [modelPopoverPos, setModelPopoverPos] = createSignal({ top: 0, left: 0 })
  const hasModelPopover = createMemo(() => showModelPopover() && !!modelInfo())
  let modelTriggerRef: HTMLButtonElement | undefined
  let modelPopoverHideTimer: number | undefined

  function clearModelPopoverTimer() {
    if (!modelPopoverHideTimer) return
    window.clearTimeout(modelPopoverHideTimer)
    modelPopoverHideTimer = undefined
  }

  function openModelPopover() {
    clearModelPopoverTimer()
    if (modelTriggerRef) {
      const rect = modelTriggerRef.getBoundingClientRect()
      const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
      const width = Math.min(rem * 20, window.innerWidth - rem)
      const maxLeft = window.innerWidth - width
      setModelPopoverPos({ top: rect.top - 8, left: Math.max(0, Math.min(rect.left, maxLeft)) })
    }
    setShowModelPopover(true)
  }

  function scheduleModelPopoverHide() {
    clearModelPopoverTimer()
    modelPopoverHideTimer = window.setTimeout(() => setShowModelPopover(false), 120)
  }

  onCleanup(clearModelPopoverTimer)

  // Token popover state — reset when session changes
  const [showTokenPopover, setShowTokenPopover] = createSignal(false)
  createEffect(() => {
    params.id // track session ID
    setShowTokenPopover(false)
    setShowModelPopover(false)
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
        <Show when={props.sessionModel()}>
          <button
            ref={modelTriggerRef}
            type="button"
            class="flex items-center gap-1 min-w-0 hover:opacity-80 cursor-pointer"
            onClick={() => {
              clearModelPopoverTimer()
              setShowModelPopover(false)
              props.onModelClick()
            }}
            onMouseEnter={openModelPopover}
            onMouseLeave={scheduleModelPopoverHide}
            onFocus={openModelPopover}
            onBlur={scheduleModelPopoverHide}
            aria-describedby={hasModelPopover() ? "model-info-popover" : undefined}
          >
            <span class="opacity-60 shrink-0">Model:</span>
            <span class="truncate" style={{ color: "var(--text-base)" }}>{modelLabel()}</span>
          </button>

          <Show when={hasModelPopover() && modelInfo()}>
            {(meta) => (
              <Portal>
                <div
                  id="model-info-popover"
                  role="tooltip"
                  class="w-80 max-w-[calc(100vw-1rem)] rounded-lg shadow-lg text-xs"
                  style={{
                    position: "fixed",
                     top: `${modelPopoverPos().top}px`,
                     left: `${modelPopoverPos().left}px`,
                     transform: "translateY(-100%)",
                     "z-index": "40",
                     background: "var(--background-base)",
                     border: "1px solid var(--border-base)",
                   }}
                  onMouseEnter={openModelPopover}
                  onMouseLeave={scheduleModelPopoverHide}
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
                    Model Details
                  </div>
                  <div class="px-3 py-2 space-y-1.5" style={{ color: "var(--text-base)" }}>
                    <div class="flex justify-between gap-3">
                      <span class="opacity-60 shrink-0">Provider</span>
                      <span class="text-right break-all">{meta().providerName} ({meta().providerID})</span>
                    </div>
                    <div class="flex justify-between gap-3">
                      <span class="opacity-60 shrink-0">Model ID</span>
                      <span class="text-right break-all">{meta().modelID}</span>
                    </div>
                    <div class="flex justify-between gap-3">
                      <span class="opacity-60 shrink-0">Name</span>
                      <span class="text-right break-all">{meta().modelName}</span>
                    </div>

                    <Show when={meta().family}>
                      <div class="flex justify-between gap-3">
                        <span class="opacity-60 shrink-0">Family</span>
                        <span class="text-right">{meta().family}</span>
                      </div>
                    </Show>
                    <Show when={meta().status}>
                      <div class="flex justify-between gap-3">
                        <span class="opacity-60 shrink-0">Status</span>
                        <span class="text-right capitalize">{meta().status}</span>
                      </div>
                    </Show>
                    <Show when={meta().releaseDate}>
                      <div class="flex justify-between gap-3">
                        <span class="opacity-60 shrink-0">Release</span>
                        <span class="text-right">{fmtDate(meta().releaseDate!)}</span>
                      </div>
                    </Show>

                    <Show when={meta().contextLimit !== undefined || meta().inputLimit !== undefined || meta().outputLimit !== undefined}>
                      <div class="pt-1" style={{ "border-top": "1px solid var(--border-base)" }}>
                        <Show when={meta().contextLimit !== undefined}>
                          <div class="flex justify-between gap-3">
                            <span class="opacity-60 shrink-0">Context Limit</span>
                            <span class="text-right">{fmt(meta().contextLimit!)}</span>
                          </div>
                        </Show>
                        <Show when={meta().inputLimit !== undefined}>
                          <div class="flex justify-between gap-3">
                            <span class="opacity-60 shrink-0">Input Limit</span>
                            <span class="text-right">{fmt(meta().inputLimit!)}</span>
                          </div>
                        </Show>
                        <Show when={meta().outputLimit !== undefined}>
                          <div class="flex justify-between gap-3">
                            <span class="opacity-60 shrink-0">Output Limit</span>
                            <span class="text-right">{fmt(meta().outputLimit!)}</span>
                          </div>
                        </Show>
                      </div>
                    </Show>

                    <Show when={modelCapabilities()}>
                      <div class="pt-1" style={{ "border-top": "1px solid var(--border-base)" }}>
                        <div class="flex justify-between gap-3">
                          <span class="opacity-60 shrink-0">Capabilities</span>
                          <span class="text-right">{modelCapabilities()}</span>
                        </div>
                      </div>
                    </Show>

                    <Show when={meta().costInput !== undefined || meta().costOutput !== undefined || meta().costCacheRead !== undefined || meta().costCacheWrite !== undefined}>
                      <div class="pt-1" style={{ "border-top": "1px solid var(--border-base)" }}>
                        <Show when={meta().costInput !== undefined}>
                          <div class="flex justify-between gap-3">
                            <span class="opacity-60 shrink-0">Cost Input</span>
                            <span class="text-right">{fmtMoney(meta().costInput!)}</span>
                          </div>
                        </Show>
                        <Show when={meta().costOutput !== undefined}>
                          <div class="flex justify-between gap-3">
                            <span class="opacity-60 shrink-0">Cost Output</span>
                            <span class="text-right">{fmtMoney(meta().costOutput!)}</span>
                          </div>
                        </Show>
                        <Show when={meta().costCacheRead !== undefined}>
                          <div class="flex justify-between gap-3">
                            <span class="opacity-60 shrink-0">Cost Cache Read</span>
                            <span class="text-right">{fmtMoney(meta().costCacheRead!)}</span>
                          </div>
                        </Show>
                        <Show when={meta().costCacheWrite !== undefined}>
                          <div class="flex justify-between gap-3">
                            <span class="opacity-60 shrink-0">Cost Cache Write</span>
                            <span class="text-right">{fmtMoney(meta().costCacheWrite!)}</span>
                          </div>
                        </Show>
                      </div>
                    </Show>
                  </div>
                </div>
              </Portal>
            )}
          </Show>
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
                       "z-index": "40",
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
        <Show when={!props.sessionModel() && providers.connected.length === 0}>
          <a href={`/${dirSlug()}/settings`} style={{ color: "var(--text-interactive-base)" }} class="hover:underline">
            Connect a provider to start
          </a>
        </Show>

        <Show when={!props.sessionModel() && providers.connected.length > 0}>
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
