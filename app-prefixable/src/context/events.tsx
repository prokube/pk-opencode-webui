import { createContext, useContext, onCleanup, onMount, type ParentProps } from "solid-js"
import { createStore, produce } from "solid-js/store"
import type { Event, SessionStatus, QuestionRequest } from "../sdk/client"
import { useBasePath } from "./base-path"
import { useSDK } from "./sdk"

type EventHandler = (event: Event) => void

interface EventContextValue {
  subscribe: (handler: EventHandler) => () => void
  status: Record<string, SessionStatus>
  pendingQuestions: Record<string, QuestionRequest | undefined>
  dismissQuestion: (sessionID: string) => void
}

const EventContext = createContext<EventContextValue>()

export function EventProvider(props: ParentProps) {
  const { prefix } = useBasePath()
  const { client, directory } = useSDK()
  const handlers = new Set<EventHandler>()
  const [status, setStatus] = createStore<Record<string, SessionStatus>>({})
  const [pendingQuestions, setPendingQuestions] = createStore<Record<string, QuestionRequest>>({})

  // Connect to SSE endpoint
  let eventSource: EventSource | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  function connect() {
    if (eventSource) return

    // Use prefixed path with directory parameter so events are scoped to the correct instance
    const dirParam = directory ? `?directory=${encodeURIComponent(directory)}` : ""
    const eventUrl = prefix(`/event${dirParam}`)
    eventSource = new EventSource(eventUrl)
    console.log("[Events] Connecting to SSE:", eventUrl)

    eventSource.onopen = () => {
      console.log("[Events] Connected")
    }

    eventSource.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data)
        // Handle both formats: direct event or wrapped in payload
        const event = (data?.payload ?? data) as Event
        if (!event || !event.type) {
          console.warn("[Events] Received event without type:", data)
          return
        }
        console.log("[Events] Received:", event.type, event.properties)

        // Update session status
        if (event.type === "session.status") {
          const props = event.properties
          if (props?.sessionID && props?.status) {
            setStatus(props.sessionID, props.status)
          }
        }

        // Track pending questions
        if (event.type === "question.asked") {
          const q = event.properties as QuestionRequest
          if (q?.sessionID) {
            setPendingQuestions(q.sessionID, q)
          }
        }
        if (event.type === "question.replied" || event.type === "question.rejected") {
          const q = event.properties as { sessionID?: string }
          if (q?.sessionID) {
            setPendingQuestions(produce((map) => { delete map[q.sessionID!] }))
          }
        }

        // Notify all handlers
        for (const handler of handlers) {
          handler(event)
        }
      } catch (err) {
        console.error("[Events] Parse error:", err)
      }
    }

    eventSource.onerror = (e) => {
      console.error("[Events] Connection error, reconnecting...", e)
      eventSource?.close()
      eventSource = null

      // Reconnect after delay
      if (!reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null
          connect()
        }, 3000)
      }
    }
  }

  // Seed initial state (questions + statuses) then connect to SSE.
  // Seed first to avoid race where replied/status events arrive before the list resolves.
  onMount(() => {
    if (!directory) { connect(); return }
    Promise.all([
      client.question.list({ directory })
        .then((res) => {
          const questions = Array.isArray(res.data) ? res.data : []
          for (const q of questions) setPendingQuestions(q.sessionID, q)
        })
        .catch((err) => console.error("[Events] Failed to load questions:", err)),
      client.session.status({ directory })
        .then((res) => {
          const statuses = (res.data ?? {}) as Record<string, SessionStatus>
          for (const [sessionID, s] of Object.entries(statuses)) setStatus(sessionID, s)
        })
        .catch((err) => console.error("[Events] Failed to load statuses:", err)),
    ]).finally(() => connect())
  })

  onCleanup(() => {
    eventSource?.close()
    if (reconnectTimer) clearTimeout(reconnectTimer)
  })

  function subscribe(handler: EventHandler) {
    handlers.add(handler)
    return () => handlers.delete(handler)
  }

  /** Optimistically remove a pending question so the UI unblocks immediately
   *  without waiting for the SSE confirmation event. */
  function dismissQuestion(sessionID: string) {
    setPendingQuestions(produce((map) => { delete map[sessionID] }))
  }

  return <EventContext.Provider value={{ subscribe, status, pendingQuestions, dismissQuestion }}>{props.children}</EventContext.Provider>
}

export function useEvents() {
  const ctx = useContext(EventContext)
  if (!ctx) throw new Error("useEvents must be used within EventProvider")
  return ctx
}
