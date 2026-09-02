import { createContext, useContext, createSignal, onCleanup, batch, type ParentProps } from "solid-js"
import { createStore, reconcile, produce } from "solid-js/store"
import type { Session, Message, Part, Provider } from "../sdk/client"
import { useSDK } from "./sdk"
import { useServer } from "./server"
import { createSSEParser, nextSSEReconnectDelay } from "../utils/sse"

// Event type - looser than SDK type to handle all events
type SyncEvent = {
  type: string
  properties: Record<string, unknown>
}

type SyncEventHandler = (event: SyncEvent) => void

export type MessageWithParts = {
  info: Message
  parts: Part[]
}

type ProviderData = {
  all: Provider[]
  connected: string[]
  default: Record<string, string>
}

type SyncStore = {
  ready: boolean
  error: string | null
  session: Session[]
  archivedSession: Session[]
  message: Record<string, MessageWithParts[]>
  part: Record<string, Part[]>
  provider: ProviderData
}

interface SyncContextValue {
  data: SyncStore
  ready: boolean
  bootstrapError: string | null
  sessions: () => Session[]
  archivedSessions: () => Session[]
  messages: (sessionID: string) => MessageWithParts[]
  parts: (messageID: string) => Part[]
  providers: () => ProviderData
  sseUnhealthy: () => boolean
  subscribe: (handler: SyncEventHandler) => () => void
  session: {
    sync: (sessionID: string) => Promise<boolean>
    get: (sessionID: string) => Session | undefined
  }
  refresh: () => Promise<void>
}

const SyncContext = createContext<SyncContextValue>()

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

function sortParts(parts: Part[]): Part[] {
  const withId = parts.filter((p) => !!p?.id).sort((a, b) => cmp(a.id, b.id))
  const withoutId = parts.filter((p) => !p?.id)
  return [...withId, ...withoutId]
}

export function mergePartUpdate(parts: Part[] | undefined, part: Part) {
  if (!parts) return sortParts([part])
  const idx = parts.findIndex((p) => p.id === part.id)
  if (idx === -1) return sortParts([...parts, part])
  return parts.map((p, i) => (i === idx ? part : p))
}

export function applyPartDelta(part: Part, field: string, delta: string) {
  if (field !== "text") return part
  if (!("text" in part)) return part
  return { ...part, text: `${part.text ?? ""}${delta}` }
}

function applyPartDeltaInPlace(parts: Part[] | undefined, partID: string, field: string, delta: string) {
  if (!parts) return false
  const idx = parts.findIndex((p) => p.id === partID)
  if (idx === -1) return false
  const next = applyPartDelta(parts[idx], field, delta)
  if (next === parts[idx]) return false
  parts[idx] = next
  return true
}

function updateMessagePartInPlace(messages: MessageWithParts[] | undefined, messageID: string, part: Part) {
  if (!messages || messages.length === 0) return false
  const msgIdx = messages.findIndex((m) => m.info.id === messageID)
  if (msgIdx === -1) return false
  messages[msgIdx].parts = mergePartUpdate(messages[msgIdx].parts, part)
  return true
}

function applyMessagePartDeltaInPlace(
  messages: MessageWithParts[] | undefined,
  messageID: string,
  partID: string,
  field: string,
  delta: string,
) {
  if (!messages || messages.length === 0) return false
  const msgIdx = messages.findIndex((m) => m.info.id === messageID)
  if (msgIdx === -1) return false
  return applyPartDeltaInPlace(messages[msgIdx].parts, partID, field, delta)
}

function toolRank(part: Extract<Part, { type: "tool" }>) {
  if (part.state.status === "pending") return 0
  if (part.state.status === "running") return 1
  return 2
}

function toolTime(part: Extract<Part, { type: "tool" }>) {
  if (part.state.status === "pending") return 0
  if (part.state.status === "running") return part.state.time.start
  return part.state.time.end
}

function mergeTextLikePart(existing: Extract<Part, { text: string }>, synced: Extract<Part, { text: string }>) {
  if ((existing.text ?? "").length > (synced.text ?? "").length) return existing
  return synced
}

function mergeSyncedPart(existing: Part, synced: Part) {
  if (existing.type !== synced.type) return synced
  if (existing.type === "text" && synced.type === "text") return mergeTextLikePart(existing, synced)
  if (existing.type === "reasoning" && synced.type === "reasoning") return mergeTextLikePart(existing, synced)
  if (existing.type !== "tool" || synced.type !== "tool") return synced

  const existingRank = toolRank(existing)
  const syncedRank = toolRank(synced)
  if (syncedRank > existingRank) return synced
  if (existingRank > syncedRank) return existing

  return toolTime(synced) > toolTime(existing) ? synced : existing
}

function mergeSyncedMessage(existing: MessageWithParts, synced: MessageWithParts) {
  const parts = synced.parts.map((part) => {
    const current = existing.parts.find((p) => p.id === part.id)
    if (!current) return part
    return mergeSyncedPart(current, part)
  })

  for (const part of existing.parts) {
    if (parts.find((p) => p.id === part.id)) continue
    parts.push(part)
  }

  return { info: synced.info, parts: sortParts(parts) }
}

export function mergeSessionMessages(existing: MessageWithParts[] | undefined, synced: MessageWithParts[]) {
  if (!existing || existing.length === 0) return synced

  const merged = synced.map((msg) => {
    const current = existing.find((m) => m.info.id === msg.info.id)
    if (!current) return msg
    return mergeSyncedMessage(current, msg)
  })

  for (const msg of existing) {
    if (merged.find((m) => m.info.id === msg.info.id)) continue
    merged.push(msg)
  }

  return merged.sort((a, b) => cmp(a.info.id, b.info.id))
}

function messageUpdateParts(
  messages: MessageWithParts[],
  index: number | undefined,
  knownParts?: Part[],
  eventParts?: Part[],
) {
  if (eventParts) return sortParts(eventParts)
  if (knownParts) return sortParts(knownParts)
  if (index !== undefined) return messages[index].parts
  return []
}

export function mergeMessageUpdate(
  messages: MessageWithParts[] | undefined,
  info: Message,
  knownParts?: Part[],
  eventParts?: Part[],
) {
  const current = messages ?? []
  const match = binarySearch(current, info.id, (m) => m.info.id)
  const parts = messageUpdateParts(current, match.found ? match.index : undefined, knownParts, eventParts)
  const next = { info, parts }

  if (match.found) return current.map((m, i) => (i === match.index ? next : m))
  const result = [...current]
  result.splice(match.index, 0, next)
  return result
}

function eventInfo<T>(props: Record<string, unknown>) {
  return (props.info ?? props) as T
}

function errorText(err: unknown) {
  if (err instanceof Error && err.message.trim()) return err.message
  return "Failed to bootstrap app state from API."
}

function binarySearch<T>(arr: T[], id: string, getId: (item: T) => string): { found: boolean; index: number } {
  let low = 0
  let high = arr.length - 1
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const midId = getId(arr[mid])
    if (midId === id) return { found: true, index: mid }
    if (midId < id) low = mid + 1
    else high = mid - 1
  }
  return { found: false, index: low }
}

export function SyncProvider(props: ParentProps) {
  const { client, directory, url: sdkUrl } = useSDK()
  const { authHeaders } = useServer()

  const [store, setStore] = createStore<SyncStore>({
    ready: false,
    error: null,
    session: [],
    archivedSession: [],
    message: {},
    part: {},
    provider: { all: [], connected: [], default: {} },
  })

  const inflight = new Map<string, Promise<boolean>>()
  const handlers = new Set<SyncEventHandler>()
  const [sseUnhealthy, setSseUnhealthy] = createSignal(false)

  // Connect to SSE endpoint using fetch (supports custom headers unlike EventSource)
  let abortController: AbortController | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectDelay = 3000

  async function connect() {
    if (abortController) return

    const dirParam = directory ? `?directory=${encodeURIComponent(directory)}` : ""
    const eventUrl = `${sdkUrl}/event${dirParam}`
    console.log("[Sync] Connecting to SSE:", eventUrl)

    abortController = new AbortController()
    const signal = abortController.signal

    let connectedAt = 0

    try {
      const response = await fetch(eventUrl, {
        headers: { ...authHeaders(), Accept: "text/event-stream" },
        signal,
      })

      if (!response.ok || !response.body) {
        throw new Error(`SSE connection failed: ${response.status}`)
      }

      console.log("[Sync] Connected, bootstrapping...")
      connectedAt = Date.now()
      setSseUnhealthy(false)
      if (!store.ready) bootstrap()

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      const parser = createSSEParser((rawData) => {
        try {
          const data = JSON.parse(rawData)
          const event = (data?.payload ?? data) as SyncEvent
          if (event?.type) handleEvent(event)
        } catch (err) {
          console.error("[Sync] Parse error:", err)
        }
      })

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        parser.push(decoder.decode(value, { stream: true }))
      }

      parser.push(decoder.decode())
      parser.push("")

      throw new Error("SSE stream ended")
    } catch (err) {
      if (signal.aborted) return
      console.error("[Sync] Connection error, reconnecting...", err)
      setSseUnhealthy(true)
      abortController = null
      reconnectDelay = nextSSEReconnectDelay(connectedAt, Date.now(), reconnectDelay)

      if (!reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null
          connect()
        }, reconnectDelay)
      }
    }
  }

  function handleEvent(event: SyncEvent) {
    const props = event.properties

    // Session events
    if (event.type === "session.created") {
      const session = eventInfo<Session>(props)
      if (!session?.id) return
      const target = session.time?.archived ? "archivedSession" : "session"
      setStore(
        target,
        produce((draft: Session[]) => {
          const match = binarySearch(draft, session.id, (s) => s.id)
          if (!match.found) draft.splice(match.index, 0, session)
        }),
      )
    }

    if (event.type === "session.updated") {
      const session = eventInfo<Session>(props)
      if (!session?.id) return
      const wasArchived = binarySearch(store.archivedSession, session.id, (s) => s.id).found
      const isArchived = !!session.time?.archived

      // If archive status changed, move between lists
      if (wasArchived && !isArchived) {
        // Restored: remove from archived, add to active
        setStore(
          "archivedSession",
          produce((draft: Session[]) => {
            const match = binarySearch(draft, session.id, (s) => s.id)
            if (match.found) draft.splice(match.index, 1)
          }),
        )
        setStore(
          "session",
          produce((draft: Session[]) => {
            const match = binarySearch(draft, session.id, (s) => s.id)
            if (!match.found) draft.splice(match.index, 0, session)
          }),
        )
      } else if (!wasArchived && isArchived) {
        // Archived: remove from active, add to archived
        setStore(
          "session",
          produce((draft: Session[]) => {
            const match = binarySearch(draft, session.id, (s) => s.id)
            if (match.found) draft.splice(match.index, 1)
          }),
        )
        setStore(
          "archivedSession",
          produce((draft: Session[]) => {
            const match = binarySearch(draft, session.id, (s) => s.id)
            if (!match.found) draft.splice(match.index, 0, session)
          }),
        )
      } else {
        // No change in archive status, just update in place
        const target = isArchived ? "archivedSession" : "session"
        setStore(
          target,
          produce((draft: Session[]) => {
            const match = binarySearch(draft, session.id, (s) => s.id)
            if (match.found) draft[match.index] = session
          }),
        )
      }
    }

    if (event.type === "session.deleted") {
      const session = eventInfo<Session>(props)
      if (!session?.id) return
      // Remove from both lists
      setStore(
        "session",
        produce((draft: Session[]) => {
          const match = binarySearch(draft, session.id, (s) => s.id)
          if (match.found) draft.splice(match.index, 1)
        }),
      )
      setStore(
        "archivedSession",
        produce((draft: Session[]) => {
          const match = binarySearch(draft, session.id, (s) => s.id)
          if (match.found) draft.splice(match.index, 1)
        }),
      )
      setStore("message", session.id, reconcile([]))
    }

    // Message part events - the main real-time update mechanism
    if (event.type === "message.part.updated") {
      const part = props.part as Part
      if (!part?.sessionID || !part?.messageID) return

      // Update or insert the part
      setStore("part", part.messageID, (existing: Part[] | undefined) => mergePartUpdate(existing, part))

      // Update parts in existing messages only - don't synthesize messages from parts
      if (store.message[part.sessionID]) {
        setStore("message", part.sessionID, produce((msgs: MessageWithParts[]) => {
          updateMessagePartInPlace(msgs, part.messageID, part)
        }))
      }
    }

    if (event.type === "message.part.delta") {
      const delta = props as { sessionID?: string; messageID?: string; partID?: string; field?: string; delta?: string }
      if (!delta.sessionID || !delta.messageID || !delta.partID || !delta.field || delta.delta === undefined) return
      const field = delta.field
      const text = delta.delta

      if (store.part[delta.messageID]) {
        setStore("part", delta.messageID, produce((existing: Part[]) => {
          applyPartDeltaInPlace(existing, delta.partID!, field, text)
        }))
      }

      if (store.message[delta.sessionID]) {
        setStore("message", delta.sessionID, produce((messages: MessageWithParts[]) => {
          applyMessagePartDeltaInPlace(messages, delta.messageID!, delta.partID!, field, text)
        }))
      }
    }

    // Message created event
    if (event.type === "message.created") {
      const msg = props as unknown as MessageWithParts
      if (!msg?.info?.sessionID) return

      setStore("message", msg.info.sessionID, (existing: MessageWithParts[]) => {
        if (!existing || existing.length === 0) return [msg]
        const match = binarySearch(existing, msg.info.id, (m) => m.info.id)
        if (match.found) return existing
        const next = [...existing]
        next.splice(match.index, 0, msg)
        return next
      })

      if (msg.parts) {
        setStore("part", msg.info.id, sortParts(msg.parts))
      }
    }

    // Message updated event
    if (event.type === "message.updated") {
      const msgProps = props as { info?: Message; parts?: Part[] }
      const info = eventInfo<Message>(props)
      const parts = msgProps.parts
      if (!info?.sessionID) return

      setStore("message", info.sessionID, (existing: MessageWithParts[] | undefined) =>
        mergeMessageUpdate(existing, info, store.part[info.id], parts),
      )

      // Also update parts store if parts were provided
      if (parts && info.id) {
        setStore("part", info.id, sortParts(parts))
      }
    }

    // Provider events
    if (event.type === "provider.updated") {
      const data = props as unknown as ProviderData
      if (data) {
        setStore("provider", data)
      }
    }

    for (const handler of handlers) {
      try {
        handler(event)
      } catch (err) {
        console.error("[Sync] Event subscriber failed:", err)
      }
    }
  }

  function subscribe(handler: SyncEventHandler) {
    handlers.add(handler)
    return () => handlers.delete(handler)
  }

  async function bootstrap() {
    setStore("error", null)
    try {
      const [sessionsRes, providersRes] = await Promise.all([client.session.list(), client.provider.list()])

      batch(() => {
        const rawSessions = sessionsRes.data ?? []
        const valid = rawSessions.filter((s: Session | undefined): s is Session => !!s?.id)
        const sessions = valid.filter((s) => !s.time?.archived).sort((a, b) => cmp(a.id, b.id))
        const archived = valid.filter((s) => !!s.time?.archived).sort((a, b) => cmp(a.id, b.id))
        setStore("session", reconcile(sessions, { key: "id" }))
        setStore("archivedSession", reconcile(archived, { key: "id" }))

        if (providersRes.data) {
          setStore("provider", providersRes.data as unknown as ProviderData)
        }

        setStore("ready", true)
      })

      console.log("[Sync] Bootstrap complete, sessions:", store.session.length)
    } catch (err) {
      console.error("[Sync] Bootstrap failed:", err)
      setStore("error", errorText(err))
    }
  }

  async function syncSession(sessionID: string) {
    const pending = inflight.get(sessionID)
    if (pending) return pending

    const promise = (async () => {
      try {
        const [sessionRes, messagesRes] = await Promise.all([
          client.session.get({ sessionID }),
          client.session.messages({ sessionID }),
        ])

        batch(() => {
          // Update session in appropriate list and remove from other list
          if (sessionRes.data) {
            const session = sessionRes.data
            const isArchived = !!session.time?.archived
            const target = isArchived ? "archivedSession" : "session"
            const other = isArchived ? "session" : "archivedSession"

            // Remove from the other list to ensure session exists in exactly one list
            setStore(
              other,
              produce((draft: Session[]) => {
                const match = binarySearch(draft, sessionID, (s) => s.id)
                if (match.found) draft.splice(match.index, 1)
              }),
            )

            // Add/update in target list
            setStore(
              target,
              produce((draft: Session[]) => {
                const match = binarySearch(draft, sessionID, (s) => s.id)
                if (match.found) {
                  draft[match.index] = session
                } else {
                  draft.splice(match.index, 0, session)
                }
              }),
            )
          }

          // Merge messages - preserve newer SSE updates
          if (messagesRes.data) {
            const synced = (messagesRes.data as MessageWithParts[])
              .filter((m): m is MessageWithParts => !!m?.info?.id)
              .sort((a, b) => cmp(a.info.id, b.info.id))

            setStore("message", sessionID, (existing: MessageWithParts[]) => mergeSessionMessages(existing, synced))

            // Update parts
            const msgs = store.message[sessionID] ?? []
            for (const msg of msgs) {
              if (msg.parts) {
                setStore("part", msg.info.id, sortParts(msg.parts))
              }
            }
          }
        })
        return true
      } catch (err) {
        console.error("[Sync] Failed to sync session:", sessionID, err)
        return false
      }
    })()

    inflight.set(sessionID, promise)
    promise.finally(() => inflight.delete(sessionID))
    return promise
  }

  async function refresh() {
    await bootstrap()
  }

  // Start connection
  connect()

  onCleanup(() => {
    abortController?.abort()
    abortController = null
    if (reconnectTimer) clearTimeout(reconnectTimer)
  })

  const value: SyncContextValue = {
    get data() {
      return store
    },
    get ready() {
      return store.ready
    },
    get bootstrapError() {
      return store.error
    },
    sessions: () => store.session,
    archivedSessions: () => store.archivedSession,
    messages: (sessionID: string) => store.message[sessionID] ?? [],
    parts: (messageID: string) => store.part[messageID] ?? [],
    providers: () => store.provider,
    sseUnhealthy,
    subscribe,
    session: {
      sync: syncSession,
      get: (sessionID: string) => {
        // Search in both active and archived sessions
        const match = binarySearch(store.session, sessionID, (s: Session) => s.id)
        if (match.found) return store.session[match.index]
        const archived = binarySearch(store.archivedSession, sessionID, (s: Session) => s.id)
        return archived.found ? store.archivedSession[archived.index] : undefined
      },
    },
    refresh,
  }

  return <SyncContext.Provider value={value}>{props.children}</SyncContext.Provider>
}

export function useSync() {
  const ctx = useContext(SyncContext)
  if (!ctx) throw new Error("useSync must be used within SyncProvider")
  return ctx
}
