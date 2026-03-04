import { createMemo, createEffect, Show } from "solid-js"
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

    // Calculate cumulative cost
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
    let lastAssistant: { contextTokens: number; modelID?: string; providerID?: string } | null = null
    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i]
      if (msg.info?.role !== "assistant") continue
      const info = msg.info as AssistantInfo
      const contextTokens = getContextTokens(info.tokens)
      if (contextTokens > 0) {
        lastAssistant = { contextTokens, modelID: info.modelID, providerID: info.providerID }
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
    const limit = model?.limit?.context
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
    }
  })

  const dirSlug = createMemo(() => params.dir)

  return (
    <div class="flex items-center gap-3 px-4 py-1.5 text-xs flex-wrap" style={{ color: "var(--text-weak)" }}>
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
        {(model) => (
          <span class="flex items-center gap-1 shrink-0">
            <span class="opacity-60">Model:</span>
            <span style={{ color: "var(--text-base)" }}>{model().modelID}</span>
          </span>
        )}
      </Show>

      {/* Token Usage */}
      <Show when={stats()}>
        {(s) => (
          <>
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
          </>
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

      {/* Enter hint / Stop button - pushed to right */}
      <div class="ml-auto flex items-center">
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
            title="Stop generation (Esc)"
          >
            <Square class="w-3 h-3" />
            <span>Stop</span>
          </button>
        </Show>
      </div>
    </div>
  )
}
