import { createContext, useContext, onCleanup, onMount, type ParentProps } from "solid-js"
import { createStore, produce } from "solid-js/store"
import type { Event, SessionStatus, QuestionRequest } from "../sdk/client"
import { useSDK } from "./sdk"
import { useServer } from "./server"
import { createSSEParser } from "../utils/sse"

type EventHandler = (event: Event) => void

interface EventContextValue {
  subscribe: (handler: EventHandler) => () => void
  status: Record<string, SessionStatus>
  pendingQuestions: Record<string, QuestionRequest | undefined>
  dismissQuestion: (sessionID: string, requestID: string) => void
}

const EventContext = createContext<EventContextValue>()

export function EventProvider(props: ParentProps) {
  const { client, directory, url: sdkUrl } = useSDK()
  const { authHeaders } = useServer()
  const handlers = new Set<EventHandler>()
  const [status, setStatus] = createStore<Record<string, SessionStatus>>({})
  const [pendingQuestions, setPendingQuestions] = createStore<Record<string, QuestionRequest | undefined>>({})

  // Connect to SSE endpoint using fetch (supports custom headers unlike EventSource)
  let abortController: AbortController | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  function processEvent(rawData: string) {
    try {
      const data = JSON.parse(rawData)
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
          sseSeenStatuses.add(props.sessionID as string)
          setStatus(props.sessionID, props.status)
        }
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
    } catch (err) {
      console.error("[Events] Parse error:", err)
    }
  }

  async function connect() {
    if (abortController) return

    const dirParam = directory ? `?directory=${encodeURIComponent(directory)}` : ""
    const eventUrl = `${sdkUrl}/event${dirParam}`
    console.log("[Events] Connecting to SSE:", eventUrl)

    abortController = new AbortController()
    const signal = abortController.signal

    try {
      const response = await fetch(eventUrl, {
        headers: { ...authHeaders(), Accept: "text/event-stream" },
        signal,
      })

      if (!response.ok || !response.body) {
        throw new Error(`SSE connection failed: ${response.status}`)
      }

      console.log("[Events] Connected")

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      const parser = createSSEParser((data) => processEvent(data))

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        parser.push(decoder.decode(value, { stream: true }))
      }

      // Flush decoder and SSE parser (trailing CR, final event boundary)
      parser.push(decoder.decode())
      parser.push("")

      // Stream ended normally, reconnect
      throw new Error("SSE stream ended")
    } catch (err) {
      if (signal.aborted) return // Intentional disconnect
      console.error("[Events] Connection error, reconnecting...", err)
      abortController = null

      if (!reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null
          connect()
        }, 3000)
      }
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

  onMount(() => {
    connect()
    if (!directory) return
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
    client.session.status({ directory })
      .then((res) => {
        const statuses = (res.data ?? {}) as Record<string, SessionStatus>
        for (const [sessionID, s] of Object.entries(statuses)) {
          if (!sseSeenStatuses.has(sessionID)) setStatus(sessionID, s)
        }
      })
      .catch((err) => console.error("[Events] Failed to load statuses:", err))
  })

  onCleanup(() => {
    abortController?.abort()
    abortController = null
    if (reconnectTimer) clearTimeout(reconnectTimer)
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

  return <EventContext.Provider value={{ subscribe, status, pendingQuestions, dismissQuestion }}>{props.children}</EventContext.Provider>
}

export function useEvents() {
  const ctx = useContext(EventContext)
  if (!ctx) throw new Error("useEvents must be used within EventProvider")
  return ctx
}
