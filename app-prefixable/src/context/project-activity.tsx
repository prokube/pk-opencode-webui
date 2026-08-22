import { createContext, createEffect, createSignal, onCleanup, type ParentProps, untrack, useContext } from "solid-js"
import type { SessionStatus } from "../sdk/client"
import { createOpencodeClient } from "../sdk/client"
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
  let poll: ReturnType<typeof setTimeout> | undefined

  function directories() {
    return new Set(projects.projects().map((project) => project.worktree))
  }

  async function refresh(directory: string) {
    const token = {}
    refreshes.set(directory, token)
    const response = await client.session.status(
      { directory },
      { signal: AbortSignal.timeout(5_000) },
    ).catch(() => undefined)
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
    }, active ? 3_000 : 10_000)
  }

  createEffect(() => {
    const current = directories()
    setStatuses((state) => Object.fromEntries(Object.entries(state).filter(([directory]) => current.has(directory))))
    for (const directory of refreshes.keys()) {
      if (!current.has(directory)) refreshes.delete(directory)
    }
    void refreshAll().finally(() => {
      if (poll) clearTimeout(poll)
      poll = undefined
      schedulePoll()
    })
  })

  onCleanup(() => {
    disposed = true
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
