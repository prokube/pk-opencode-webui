import { createContext, useContext, createSignal, onCleanup, onMount, type ParentProps } from "solid-js"
import { createStore, produce } from "solid-js/store"
import type { Event, SessionStatus, QuestionRequest } from "../sdk/client"
import { useSDK } from "./sdk"
import { useSync } from "./sync"

type EventHandler = (event: Event) => void

type SessionStatusEvent = {
  sessionID: string
  status: SessionStatus
}

export function sessionStatusEvent(event: { type: string; properties?: unknown }): SessionStatusEvent | undefined {
  const props = event.properties as { sessionID?: string; status?: SessionStatus } | undefined
  if (!props?.sessionID) return undefined
  if (event.type === "session.status" && props.status) return { sessionID: props.sessionID, status: props.status }
  if (event.type === "session.idle") return { sessionID: props.sessionID, status: { type: "idle" } }
  return undefined
}

interface EventContextValue {
  subscribe: (handler: EventHandler) => () => void
  status: Record<string, SessionStatus>
  statusReady: () => boolean
  pendingQuestions: Record<string, QuestionRequest | undefined>
  dismissQuestion: (sessionID: string, requestID: string) => void
  setSessionStatus: (sessionID: string, status: SessionStatus) => void
}

const EventContext = createContext<EventContextValue>()

export function EventProvider(props: ParentProps) {
  const { client, directory } = useSDK()
  const sync = useSync()
  const handlers = new Set<EventHandler>()
  const [status, setStatus] = createStore<Record<string, SessionStatus>>({})
  const [statusReady, setStatusReady] = createSignal(false)
  const [pendingQuestions, setPendingQuestions] = createStore<Record<string, QuestionRequest | undefined>>({})

  function processEvent(event: Event) {
    if (!event || !event.type) return

      // Update session status
      const statusEvent = sessionStatusEvent(event)
      if (statusEvent) {
        sseSeenStatuses.add(statusEvent.sessionID)
        setStatus(statusEvent.sessionID, statusEvent.status)
      }

      // Track pending questions
      if (event.type === "question.asked") {
        const q = event.properties as QuestionRequest
        if (q?.sessionID) {
          sseAskedQuestions.add(q.sessionID)
          setPendingQuestions(q.sessionID, q)
        }
      }
      if (event.type === "question.replied" || event.type === "question.rejected") {
        const q = event.properties as { sessionID?: string; requestID?: string }
        if (q?.sessionID) {
          if (q.requestID) sseClearedRequests.add(q.requestID)
          setPendingQuestions(produce((map) => {
            if (!q.requestID || map[q.sessionID!]?.id === q.requestID) delete map[q.sessionID!]
          }))
        }
      }

      // Notify all handlers
      for (const handler of handlers) {
        handler(event)
      }
  }

  // Connect SSE and seed initial state concurrently. SSE is connected first so
  // no events are missed during the HTTP flight. The HTTP seed only applies
  // entries for sessions that haven't already been touched by a live SSE event,
  // preventing stale HTTP snapshots from overwriting newer SSE updates.
  //
  // sseAskedQuestions: sessions that received a question.asked via SSE (skip HTTP seed)
  // sseClearedRequests: specific requestIDs cleared via SSE (skip that question in HTTP seed)
  // sseSeenStatuses: sessions with a status update via SSE (skip HTTP seed)
  const sseAskedQuestions = new Set<string>()
  const sseClearedRequests = new Set<string>()
  const sseSeenStatuses = new Set<string>()

  function seedStatus() {
    if (!directory) {
      setStatusReady(true)
      return
    }
    client.session.status({ directory })
      .then((res) => {
        const statuses = (res.data ?? {}) as Record<string, SessionStatus>
        for (const [sessionID, s] of Object.entries(statuses)) {
          if (!sseSeenStatuses.has(sessionID)) setStatus(sessionID, s)
        }
        setStatusReady(true)
      })
      .catch((err) => console.error("[Events] Failed to load statuses:", err))
  }

  const unsubSync = sync.subscribe((event) => {
    if (event.type === "server.connected") {
      sseSeenStatuses.clear()
      sseAskedQuestions.clear()
      sseClearedRequests.clear()
      seedStatus()
    }
    processEvent(event as Event)
  })

  onMount(() => {
    if (!directory) {
      setStatusReady(true)
      return
    }
    client.question.list({ directory })
      .then((res) => {
        const questions = Array.isArray(res.data) ? res.data : []
        for (const q of questions) {
          // Skip if SSE already delivered a question.asked for this session
          // or if this specific request was already cleared via SSE
          if (sseAskedQuestions.has(q.sessionID)) continue
          if (sseClearedRequests.has(q.id)) continue
          setPendingQuestions(q.sessionID, q)
        }
      })
      .catch((err) => console.error("[Events] Failed to load questions:", err))
    seedStatus()
  })

  onCleanup(() => {
    unsubSync()
  })

  function subscribe(handler: EventHandler) {
    handlers.add(handler)
    return () => handlers.delete(handler)
  }

  /** Optimistically remove a pending question so the UI unblocks immediately
   *  without waiting for the SSE confirmation event. Only deletes when the
   *  currently stored request matches the given requestID to avoid clearing a
   *  newer question that arrived in the meantime. */
  function dismissQuestion(sessionID: string, requestID: string) {
    setPendingQuestions(produce((map) => {
      if (map[sessionID]?.id === requestID) delete map[sessionID]
    }))
  }

  return <EventContext.Provider value={{ subscribe, status, statusReady, pendingQuestions, dismissQuestion, setSessionStatus: setStatus }}>{props.children}</EventContext.Provider>
}

export function useEvents() {
  const ctx = useContext(EventContext)
  if (!ctx) throw new Error("useEvents must be used within EventProvider")
  return ctx
}
