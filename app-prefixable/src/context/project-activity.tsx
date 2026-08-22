import { createContext, createEffect, createSignal, onCleanup, type ParentProps, untrack, useContext } from "solid-js"
import type { Event, SessionStatus } from "../sdk/client"
import { createOpencodeClient } from "../sdk/client"
import { createSSEParser } from "../utils/sse"
import { useProjects } from "./projects"
import { useServer } from "./server"
import { sessionIsWorking } from "../utils/session-tree-request"

type ProjectStatuses = Record<string, Record<string, SessionStatus>>

export function reduceProjectActivity(
  state: ProjectStatuses,
  directory: string,
  event: { type: string; properties?: unknown },
) {
  const props = event.properties as { sessionID?: string; status?: SessionStatus; info?: { id?: string } } | undefined
  const sessionID = props?.sessionID ?? props?.info?.id
  if (!sessionID) return state

  const status = event.type === "session.status"
    ? props?.status
    : event.type === "session.idle"
      ? { type: "idle" } as const
      : undefined
  if (!status && event.type !== "session.deleted") return state

  const project = { ...(state[directory] ?? {}) }
  if (event.type === "session.deleted") delete project[sessionID]
  if (status) project[sessionID] = status
  return { ...state, [directory]: project }
}

interface ProjectActivityContextValue {
  working: (directory: string) => boolean
}

const ProjectActivityContext = createContext<ProjectActivityContextValue>()

export function ProjectActivityProvider(props: ParentProps) {
  const projects = useProjects()
  const server = useServer()
  const client = createOpencodeClient({
    baseUrl: server.serverUrl(),
    headers: server.authHeaders(),
    throwOnError: true,
  })
  const [statuses, setStatuses] = createSignal<ProjectStatuses>({})
  const refreshes = new Map<string, object>()
  let disposed = false
  let controller: AbortController | undefined
  let reconnect: ReturnType<typeof setTimeout> | undefined
  let poll: ReturnType<typeof setTimeout> | undefined

  function directories() {
    return new Set(projects.projects().map((project) => project.worktree))
  }

  async function refresh(directory: string) {
    const token = {}
    refreshes.set(directory, token)
    const response = await client.session.status({ directory }).catch(() => undefined)
    if (disposed || refreshes.get(directory) !== token || !response?.data) return
    setStatuses((current) => ({ ...current, [directory]: response.data }))
  }

  async function refreshAll() {
    await Promise.all([...directories()].map(refresh))
  }

  function schedulePoll() {
    if (poll || disposed) return
    const active = Object.values(untrack(statuses)).some((project) => Object.values(project).some(sessionIsWorking))
    poll = setTimeout(async () => {
      poll = undefined
      await refreshAll()
      schedulePoll()
    }, active ? 5_000 : 30_000)
  }

  function apply(directory: string, event: Event) {
    if (!directories().has(directory)) return
    if (event.type !== "session.status" && event.type !== "session.idle" && event.type !== "session.deleted") return
    refreshes.delete(directory)
    setStatuses((current) => reduceProjectActivity(current, directory, event))
    if (poll) clearTimeout(poll)
    poll = undefined
    schedulePoll()
  }

  async function connect() {
    if (controller || disposed) return
    controller = new AbortController()
    const signal = controller.signal
    try {
      const response = await fetch(`${server.serverUrl().replace(/\/$/, "")}/global/event`, {
        headers: { ...server.authHeaders(), Accept: "text/event-stream" },
        signal,
      })
      if (!response.ok || !response.body) throw new Error(`SSE connection failed: ${response.status}`)
      void refreshAll()
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      const parser = createSSEParser((raw) => {
        try {
          const data = JSON.parse(raw) as { directory?: string; payload?: Event }
          if (data.directory && data.payload?.type) apply(data.directory, data.payload)
        } catch {
          // Ignore malformed global events; polling repairs missed state.
        }
      })
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        parser.push(decoder.decode(chunk.value, { stream: true }))
      }
      parser.push(decoder.decode())
      parser.push("")
    } catch {
      if (signal.aborted || disposed) return
    } finally {
      if (controller?.signal === signal) controller = undefined
    }
    if (!disposed && !reconnect) {
      reconnect = setTimeout(() => {
        reconnect = undefined
        void connect()
      }, 3_000)
    }
  }

  createEffect(() => {
    const current = directories()
    setStatuses((state) => Object.fromEntries(Object.entries(state).filter(([directory]) => current.has(directory))))
    for (const directory of refreshes.keys()) {
      if (!current.has(directory)) refreshes.delete(directory)
    }
    for (const directory of current) void refresh(directory)
    schedulePoll()
  })

  void connect()

  onCleanup(() => {
    disposed = true
    controller?.abort()
    if (reconnect) clearTimeout(reconnect)
    if (poll) clearTimeout(poll)
  })

  return (
    <ProjectActivityContext.Provider value={{
      working: (directory) => Object.values(statuses()[directory] ?? {}).some(sessionIsWorking),
    }}>
      {props.children}
    </ProjectActivityContext.Provider>
  )
}

export function useProjectActivity() {
  const context = useContext(ProjectActivityContext)
  if (!context) throw new Error("useProjectActivity must be used within ProjectActivityProvider")
  return context
}
