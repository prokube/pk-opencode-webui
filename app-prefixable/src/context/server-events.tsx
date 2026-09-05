import { batch, createContext, createSignal, onCleanup, type ParentProps, useContext } from "solid-js"
import type { Event } from "../sdk/client"
import { createScheduledEventBuffer } from "../utils/event-buffer"
import { createSSEParser, nextSSEReconnectDelay } from "../utils/sse"
import { useServer } from "./server"

export type ServerEvent = {
  directory: string
  payload: Event
}

type ServerEventHandler = (event: ServerEvent) => void
type ServerRecoveryHandler = (reason: "connected" | "overflow") => void

interface ServerEventsContextValue {
  connected: () => boolean
  unhealthy: () => boolean
  recover: (handler: ServerRecoveryHandler) => () => void
  subscribe: (handler: ServerEventHandler) => () => void
}

const ServerEventsContext = createContext<ServerEventsContextValue>()

export function coalesceServerEvent(previous: ServerEvent, event: ServerEvent) {
  if (previous.directory !== event.directory) return
  if (previous.payload.type !== "message.part.delta" || event.payload.type !== "message.part.delta") return
  const before = previous.payload.properties
  const next = event.payload.properties
  if (
    before.sessionID !== next.sessionID ||
    before.messageID !== next.messageID ||
    before.partID !== next.partID ||
    before.field !== next.field
  ) return
  return {
    ...event,
    payload: { ...event.payload, properties: { ...next, delta: before.delta + next.delta } },
  } satisfies ServerEvent
}

export function parseServerEvent(raw: string) {
  const data = JSON.parse(raw) as Partial<ServerEvent>
  const payload = data.payload
  if (!payload) return
  const type = (payload as { type?: unknown }).type
  if (typeof type !== "string" || type === "sync") return
  const directory = typeof data.directory === "string" && data.directory ? data.directory : "global"
  return { directory, payload }
}

export function ServerEventsProvider(props: ParentProps) {
  const server = useServer()
  const handlers = new Set<ServerEventHandler>()
  const recoveries = new Set<ServerRecoveryHandler>()
  const [connected, setConnected] = createSignal(false)
  const [unhealthy, setUnhealthy] = createSignal(false)
  const encoder = new TextEncoder()
  const recover = (reason: "connected" | "overflow") => {
    for (const handler of recoveries) {
      try {
        handler(reason)
      } catch (error) {
        console.error("[Events] Recovery subscriber failed:", error)
      }
    }
  }
  const pending = createScheduledEventBuffer<ServerEvent>((event) => {
    if (event.payload.type === "server.connected") {
      setConnected(true)
      recover("connected")
    }
    for (const handler of handlers) {
      try {
        handler(event)
      } catch (error) {
        console.error("[Events] Subscriber failed:", error)
      }
    }
  }, {
    coalesce: coalesceServerEvent,
    limit: 5_000,
    byteLimit: 2 * 1024 * 1024,
    size: (event) => encoder.encode(JSON.stringify(event)).byteLength,
    resetOnOverflow: true,
    overflow: () => recover("overflow"),
    run: batch,
  })
  let controller: AbortController | undefined
  let reconnect: ReturnType<typeof setTimeout> | undefined
  let delay = 3_000
  let disposed = false

  async function connect() {
    if (controller || disposed) return
    controller = new AbortController()
    const signal = controller.signal
    const connected = { at: 0 }
    try {
      const response = await fetch(`${server.serverUrl().replace(/\/$/, "")}/global/event`, {
        headers: { ...server.authHeaders(), Accept: "text/event-stream" },
        signal,
      })
      if (!response.ok || !response.body) throw new Error(`SSE connection failed: ${response.status}`)
      connected.at = Date.now()
      setUnhealthy(false)

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      const parser = createSSEParser((raw) => {
        try {
          const event = parseServerEvent(raw)
          if (event) pending.push(event)
        } catch (error) {
          console.error("[Events] Parse error:", error)
        }
      })
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        parser.push(decoder.decode(chunk.value, { stream: true }))
      }
      parser.push(decoder.decode())
      parser.push("")
      throw new Error("SSE stream ended")
    } catch (error) {
      if (signal.aborted || disposed) return
      console.error("[Events] Connection error, reconnecting...", error)
      setConnected(false)
      setUnhealthy(true)
    } finally {
      if (controller?.signal === signal) controller = undefined
    }
    delay = nextSSEReconnectDelay(connected.at, Date.now(), delay)
    if (disposed || reconnect) return
    reconnect = setTimeout(() => {
      reconnect = undefined
      void connect()
    }, delay)
  }

  void connect()

  onCleanup(() => {
    disposed = true
    pending.dispose()
    controller?.abort()
    if (reconnect) clearTimeout(reconnect)
  })

  return (
    <ServerEventsContext.Provider value={{
      connected,
      unhealthy,
      recover: (handler) => {
        recoveries.add(handler)
        return () => {
          recoveries.delete(handler)
        }
      },
      subscribe: (handler) => {
        handlers.add(handler)
        return () => {
          handlers.delete(handler)
        }
      },
    }}>
      {props.children}
    </ServerEventsContext.Provider>
  )
}

export function useServerEvents() {
  const context = useContext(ServerEventsContext)
  if (!context) throw new Error("useServerEvents must be used within ServerEventsProvider")
  return context
}
