import { createContext, useContext, onCleanup, batch, type ParentProps } from "solid-js"
import { createStore, reconcile, produce } from "solid-js/store"
import type { Session, Message, Part, Provider } from "../sdk/client"
import { useBasePath } from "./base-path"
import { useSDK } from "./sdk"

// Event type - looser than SDK type to handle all events
type SyncEvent = {
  type: string
  properties: Record<string, unknown>
}

type MessageWithParts = {
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
  session: Session[]
  archivedSession: Session[]
  message: Record<string, MessageWithParts[]>
  part: Record<string, Part[]>
  provider: ProviderData
}

interface SyncContextValue {
  data: SyncStore
  ready: boolean
  sessions: () => Session[]
  archivedSessions: () => Session[]
  messages: (sessionID: string) => MessageWithParts[]
  parts: (messageID: string) => Part[]
  providers: () => ProviderData
  session: {
    sync: (sessionID: string) => Promise<void>
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
  const { prefix } = useBasePath()
  const { client, directory } = useSDK()

  const [store, setStore] = createStore<SyncStore>({
    ready: false,
    session: [],
    archivedSession: [],
    message: {},
    part: {},
    provider: { all: [], connected: [], default: {} },
  })

  const inflight = new Map<string, Promise<void>>()

  // Connect to SSE endpoint
  let eventSource: EventSource | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  function connect() {
    if (eventSource) return

    const dirParam = directory ? `?directory=${encodeURIComponent(directory)}` : ""
    const eventUrl = prefix(`/event${dirParam}`)
    eventSource = new EventSource(eventUrl)
    console.log("[Sync] Connecting to SSE:", eventUrl)

    eventSource.onopen = () => {
      console.log("[Sync] Connected, bootstrapping...")
      if (!store.ready) bootstrap()
    }

    eventSource.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data)
        const event = (data?.payload ?? data) as SyncEvent
        if (!event || !event.type) return
        handleEvent(event)
      } catch (err) {
        console.error("[Sync] Parse error:", err)
      }
    }

    eventSource.onerror = () => {
      console.error("[Sync] Connection error, reconnecting...")
      eventSource?.close()
      eventSource = null

      if (!reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null
          connect()
        }, 3000)
      }
    }
  }

  function handleEvent(event: SyncEvent) {
    console.log("[Sync] Event:", event.type)
    const props = event.properties

    // Session events
    if (event.type === "session.created") {
      const session = props as unknown as Session
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
      const session = props as unknown as Session
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
      const sessionID = props.sessionID as string | undefined
      if (!sessionID) return
      // Remove from both lists
      setStore(
        "session",
        produce((draft: Session[]) => {
          const match = binarySearch(draft, sessionID, (s) => s.id)
          if (match.found) draft.splice(match.index, 1)
        }),
      )
      setStore(
        "archivedSession",
        produce((draft: Session[]) => {
          const match = binarySearch(draft, sessionID, (s) => s.id)
          if (match.found) draft.splice(match.index, 1)
        }),
      )
      setStore("message", sessionID, reconcile([]))
    }

    // Message part events - the main real-time update mechanism
    if (event.type === "message.part.updated") {
      const part = props.part as Part
      if (!part?.sessionID || !part?.messageID) return

      // Update or insert the part
      setStore("part", part.messageID, (existing: Part[] | undefined) => {
        if (!existing) return sortParts([part])
        const idx = existing.findIndex((p) => p.id === part.id)
        if (idx === -1) return sortParts([...existing, part])
        return existing.map((p, i) => (i === idx ? part : p))
      })

      // Update parts in existing messages only - don't synthesize messages from parts
      setStore("message", part.sessionID, (msgs: MessageWithParts[]) => {
        if (!msgs || msgs.length === 0) return msgs

        const msgIdx = msgs.findIndex((m) => m.info.id === part.messageID)
        if (msgIdx === -1) return msgs

        // Update existing message parts
        return msgs.map((m, i) => {
          if (i !== msgIdx) return m
          const partIdx = m.parts.findIndex((p) => p.id === part.id)
          const newParts = partIdx === -1 ? [...m.parts, part] : m.parts.map((p, pi) => (pi === partIdx ? part : p))
          return { ...m, parts: newParts }
        })
      })
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
      const info = msgProps.info
      if (!info?.sessionID) return

      setStore("message", info.sessionID, (existing: MessageWithParts[]) => {
        if (!existing || existing.length === 0) return existing
        return existing.map((m) => (m.info.id === info.id ? { ...m, info } : m))
      })
    }

    // Provider events
    if (event.type === "provider.updated") {
      const data = props as unknown as ProviderData
      if (data) {
        setStore("provider", data)
      }
    }
  }

  async function bootstrap() {
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

            setStore("message", sessionID, (existing: MessageWithParts[]) => {
              if (!existing || existing.length === 0) return synced

              // Merge: use existing message if it has more recent parts
              const merged = synced.map((s) => {
                const e = existing.find((m) => m.info.id === s.info.id)
                if (!e) return s
                // Keep existing if it has more parts (SSE updates arrived)
                return e.parts.length >= s.parts.length ? e : s
              })

              // Add any messages from existing that aren't in synced (new SSE messages)
              for (const e of existing) {
                if (!merged.find((m) => m.info.id === e.info.id)) {
                  merged.push(e)
                }
              }

              return merged.sort((a, b) => cmp(a.info.id, b.info.id))
            })

            // Update parts
            const msgs = store.message[sessionID] ?? []
            for (const msg of msgs) {
              if (msg.parts) {
                setStore("part", msg.info.id, sortParts(msg.parts))
              }
            }
          }
        })
      } catch (err) {
        console.error("[Sync] Failed to sync session:", sessionID, err)
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
    eventSource?.close()
    if (reconnectTimer) clearTimeout(reconnectTimer)
  })

  const value: SyncContextValue = {
    get data() {
      return store
    },
    get ready() {
      return store.ready
    },
    sessions: () => store.session,
    archivedSessions: () => store.archivedSession,
    messages: (sessionID: string) => store.message[sessionID] ?? [],
    parts: (messageID: string) => store.part[messageID] ?? [],
    providers: () => store.provider,
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
