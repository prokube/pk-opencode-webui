import { createSignal, createEffect, createMemo, For, Show, onCleanup } from "solid-js"
import { useSDK } from "../context/sdk"
import { useEvents } from "../context/events"
import { useProviders } from "../context/providers"
import { GitBranch, Check, Circle, Loader2, Zap } from "lucide-solid"

interface Todo {
  id: string
  content: string
  status: string
  priority: string
}

interface SessionSidebarProps {
  sessionId: string | undefined
}

export function SessionSidebar(props: SessionSidebarProps) {
  const { client, directory } = useSDK()
  const events = useEvents()
  const providers = useProviders()

  const [todos, setTodos] = createSignal<Todo[]>([])
  const [branch, setBranch] = createSignal<string | null>(null)
  const [messages, setMessages] = createSignal<any[]>([])

  // Load git branch
  async function loadBranch() {
    try {
      console.log("[SessionSidebar] Loading branch, directory:", directory)
      const res = await client.vcs.get({ directory })
      console.log("[SessionSidebar] Branch response:", res)
      if (res.data?.branch) {
        setBranch(res.data.branch)
      }
    } catch (e) {
      console.error("[SessionSidebar] Failed to load branch:", e)
    }
  }

  // Load todos for session
  async function loadTodos(sessionId: string) {
    try {
      const res = await client.session.todo({ sessionID: sessionId, directory })
      if (res.data) {
        setTodos(res.data as Todo[])
      }
    } catch (e) {
      console.error("[SessionSidebar] Failed to load todos:", e)
      setTodos([])
    }
  }

  // Load messages for token calculation
  async function loadMessages(sessionId: string) {
    try {
      const res = await client.session.messages({ sessionID: sessionId })
      if (res.data) {
        setMessages(res.data)
      }
    } catch (e) {
      console.error("[SessionSidebar] Failed to load messages:", e)
    }
  }

  // Load data when sessionId changes
  createEffect(() => {
    const id = props.sessionId
    loadBranch()
    if (id) {
      loadTodos(id)
      loadMessages(id)
    } else {
      setTodos([])
      setMessages([])
    }
  })

  // Calculate context usage from last assistant message
  // Context usage = input tokens, which represents how much of the context window is used
  const contextUsage = createMemo(() => {
    const msgs = messages()
    if (!msgs.length) return null

    // Find last assistant message with tokens and extract model info
    let inputTokens = 0
    let msgProviderID: string | undefined
    let msgModelID: string | undefined
    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i]
      if (msg.info?.role !== "assistant") continue
      const tokens = msg.info.tokens
      // Input tokens represent the context size - how much of the window is used
      // This includes the conversation history sent to the model
      if (tokens?.input && tokens.input > 0) {
        inputTokens = tokens.input
        // Extract provider/model from the message that produced these tokens
        msgProviderID = msg.info.providerID
        msgModelID = msg.info.modelID
        break
      }
    }

    if (inputTokens === 0) return null

    // Get model context limit from the message's model, not the currently selected one
    const providerID = msgProviderID ?? providers.selectedModel?.providerID
    const modelID = msgModelID ?? providers.selectedModel?.modelID
    const provider = providers.providers.find((p) => p.id === providerID)
    const model = provider?.models[modelID ?? ""]
    const limit = (model as any)?.limit?.context as number | undefined

    if (!limit) return { tokens: inputTokens, limit: null, percentage: null, remaining: null }

    const percentage = Math.max(0, Math.min(100, Math.round((inputTokens / limit) * 100)))
    const remaining = Math.max(0, limit - inputTokens)

    return { tokens: inputTokens, limit, percentage, remaining }
  })

  // Subscribe to todo and message updates
  createEffect(() => {
    const id = props.sessionId
    if (!id) return

    const unsub = events.subscribe((event) => {
      if (event.type === "todo.updated") {
        const eventProps = event.properties as { sessionID: string; todos: Todo[] }
        if (eventProps.sessionID === id) {
          setTodos(eventProps.todos)
        }
      }
      if (event.type === "vcs.branch.updated") {
        const eventProps = event.properties as { branch: string }
        setBranch(eventProps.branch)
      }
      // Reload messages when assistant message completes (for token updates)
      if (event.type === "message.updated") {
        const props = event.properties as { sessionID?: string }
        if (props.sessionID === id) {
          loadMessages(id)
        }
      }
    })

    onCleanup(unsub)
  })

  const statusIcon = (status: string) => {
    switch (status) {
      case "completed":
        return <Check class="w-3 h-3 shrink-0" style={{ color: "var(--icon-success-base)" }} />
      case "in_progress":
        return <Loader2 class="w-3 h-3 shrink-0 animate-spin" style={{ color: "var(--text-interactive-base)" }} />
      default:
        return <Circle class="w-3 h-3 shrink-0" style={{ color: "var(--icon-weak)" }} />
    }
  }

  const pendingTodos = () => todos().filter((t) => t.status === "pending" || t.status === "in_progress")
  const completedTodos = () => todos().filter((t) => t.status === "completed" || t.status === "cancelled")

  return (
    <div class="h-full flex flex-col overflow-hidden" style={{ background: "var(--background-base)" }}>
      {/* Header */}
      <div class="flex items-center px-3 py-2" style={{ "border-bottom": "1px solid var(--border-base)" }}>
        <span class="text-xs font-medium uppercase" style={{ color: "var(--text-weak)" }}>
          Info
        </span>
      </div>

      {/* Git Branch */}
      <Show when={branch()}>
        <div class="px-3 py-2 flex items-center gap-2" style={{ "border-bottom": "1px solid var(--border-base)" }}>
          <GitBranch class="w-3 h-3 shrink-0" style={{ color: "var(--icon-weak)" }} />
          <span class="text-xs font-mono truncate" style={{ color: "var(--text-base)" }}>
            {branch()}
          </span>
        </div>
      </Show>

      {/* Todos */}
      <div class="flex-1 overflow-y-auto">
        <Show
          when={todos().length > 0}
          fallback={
            <div class="px-3 py-3 text-center">
              <span class="text-xs" style={{ color: "var(--text-weak)" }}>
                No tasks
              </span>
            </div>
          }
        >
          {/* Pending/In Progress */}
          <Show when={pendingTodos().length > 0}>
            <div class="px-3 py-2">
              <div class="text-xs font-medium uppercase mb-1.5" style={{ color: "var(--text-weak)" }}>
                Tasks ({pendingTodos().length})
              </div>
              <div class="space-y-1">
                <For each={pendingTodos()}>
                  {(todo) => (
                    <div class="flex items-start gap-2 py-0.5">
                      <div class="pt-0.5">{statusIcon(todo.status)}</div>
                      <span class="text-xs" style={{ color: "var(--text-base)" }}>
                        {todo.content}
                      </span>
                    </div>
                  )}
                </For>
              </div>
            </div>
          </Show>

          {/* Completed */}
          <Show when={completedTodos().length > 0}>
            <div class="px-3 py-2">
              <div class="text-xs font-medium uppercase mb-1.5" style={{ color: "var(--text-weak)" }}>
                Done ({completedTodos().length})
              </div>
              <div class="space-y-1">
                <For each={completedTodos()}>
                  {(todo) => (
                    <div class="flex items-start gap-2 py-0.5 opacity-50">
                      <div class="pt-0.5">{statusIcon(todo.status)}</div>
                      <span class="text-xs line-through" style={{ color: "var(--text-weak)" }}>
                        {todo.content}
                      </span>
                    </div>
                  )}
                </For>
              </div>
            </div>
          </Show>
        </Show>
      </div>

      {/* Context Usage - below Todos */}
      <Show when={contextUsage()}>
        {(usage) => {
          const isWarning = () => (usage().percentage ?? 0) > 80
          return (
            <div class="px-3 py-2" style={{ "border-top": "1px solid var(--border-base)" }}>
              <div class="text-xs font-medium uppercase mb-1.5" style={{ color: "var(--text-weak)" }}>
                Context
              </div>
              <Show when={usage().limit !== null}>
                {/* Progress bar */}
                <div class="h-1.5 rounded-full overflow-hidden mb-1.5" style={{ background: "var(--surface-inset)" }}>
                  <div
                    class="h-full rounded-full transition-all"
                    style={{
                      width: `${Math.min(usage().percentage ?? 0, 100)}%`,
                      background: isWarning() ? "var(--interactive-critical)" : "var(--interactive-base)",
                    }}
                  />
                </div>
                {/* Stats */}
                <div class="flex items-center justify-between text-[10px]">
                  <span style={{ color: isWarning() ? "var(--text-critical-base)" : "var(--text-weak)" }}>
                    {usage().percentage}% used
                  </span>
                  <span style={{ color: "var(--text-weak)" }}>
                    ~{Math.round((usage().remaining ?? 0) / 1000)}k remaining
                  </span>
                </div>
                <div class="text-[10px] mt-0.5" style={{ color: "var(--text-weak)" }}>
                  {usage().tokens?.toLocaleString()} / {usage().limit?.toLocaleString()} tokens
                </div>
              </Show>
              <Show when={usage().limit === null}>
                <div class="flex items-center gap-1.5 text-xs" style={{ color: "var(--text-base)" }}>
                  <Zap class="w-3 h-3" />
                  <span>{usage().tokens?.toLocaleString()} tokens</span>
                </div>
              </Show>
            </div>
          )
        }}
      </Show>
    </div>
  )
}
