import { createContext, createEffect, createSignal, onCleanup, type ParentProps, untrack, useContext } from "solid-js"
import type { SessionStatus } from "../sdk/client"
import { createOpencodeClient } from "../sdk/client"
import { useProjects } from "./projects"
import { useServer } from "./server"
import { sessionIsWorking } from "../utils/session-tree-request"
import { useBrowserNotifications } from "./browser-notifications"

type ProjectStatuses = Record<string, Record<string, SessionStatus>>
export type ProjectActivityBadge = { type: "permission" | "question" | "working"; count: number }

export function projectActivityBadge(statuses: Record<string, SessionStatus>, questions: number, permissions: number) {
  if (permissions) return { type: "permission", count: permissions } satisfies ProjectActivityBadge
  if (questions) return { type: "question", count: questions } satisfies ProjectActivityBadge
  const working = Object.values(statuses).filter(sessionIsWorking).length
  if (working) return { type: "working", count: working } satisfies ProjectActivityBadge
}

export function completedSessionIDs(previous: Record<string, SessionStatus>, next: Record<string, SessionStatus>) {
  return Object.entries(previous)
    .filter(([sessionID, status]) => sessionIsWorking(status) && (!next[sessionID] || !sessionIsWorking(next[sessionID])))
    .map(([sessionID]) => sessionID)
}

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
  badge: (directory: string) => ProjectActivityBadge | undefined
  setActive: (directory?: string) => void
}

const ProjectActivityContext = createContext<ProjectActivityContextValue>()

export function ProjectActivityProvider(props: ParentProps) {
  const projects = useProjects()
  const server = useServer()
  const notifications = useBrowserNotifications()
  const client = createOpencodeClient({
    baseUrl: server.serverUrl(),
    headers: server.authHeaders(),
    throwOnError: true,
  })
  const [statuses, setStatuses] = createSignal<ProjectStatuses>({})
  const [questions, setQuestions] = createSignal<Record<string, number>>({})
  const [permissions, setPermissions] = createSignal<Record<string, number>>({})
  const [active, setActive] = createSignal<string>()
  const refreshes = new Map<string, object>()
  const attention = new Map<string, { questions: Set<string>; permissions: Set<string> }>()
  let disposed = false
  let poll: ReturnType<typeof setTimeout> | undefined

  function directories() {
    return new Set(projects.projects().map((project) => project.worktree).filter((directory) => directory !== active()))
  }

  async function refresh(directory: string) {
    const token = {}
    refreshes.set(directory, token)
    const options = () => ({ signal: AbortSignal.timeout(5_000) })
    const [status, question, permission] = await Promise.all([
      client.session.status({ directory }, options()).catch(() => undefined),
      client.question.list({ directory }, options()).catch(() => undefined),
      client.permission.list({ directory }, options()).catch(() => undefined),
    ])
    if (disposed || refreshes.get(directory) !== token) return
    const previous = statuses()[directory]
    const next = status?.data ?? previous ?? {}
    const previousAttention = attention.get(directory)
    const currentAttention = {
      questions: question ? new Set((question.data ?? []).map((item) => item.id)) : previousAttention?.questions ?? new Set<string>(),
      permissions: permission ? new Set((permission.data ?? []).map((item) => item.id)) : previousAttention?.permissions ?? new Set<string>(),
    }
    const failed = new Set<string>()
    if (previous && status) {
      await Promise.all(completedSessionIDs(previous, next).map(async (sessionID) => {
        const [sessionResult, messagesResult] = await Promise.all([
          client.session.get({ sessionID, directory }, options()).catch(() => undefined),
          client.session.messages({ sessionID, directory }, options()).catch(() => undefined),
        ])
        if (!sessionResult || !messagesResult) {
          failed.add(sessionID)
          return
        }
        if (disposed || refreshes.get(directory) !== token || !directories().has(directory)) return
        const session = sessionResult.data
        if (!session || session.parentID) return
        const assistant = [...(messagesResult.data ?? [])].reverse().find((message) => message.info.role === "assistant")?.info
        if (assistant?.role === "assistant" && assistant.error?.name === "MessageAbortedError") return
        if (assistant?.role === "assistant" && assistant.error) {
          notifications.notify("errors", "Session error", session.title ?? sessionID, directory, sessionID, `opencode:error:${directory}:${sessionID}`)
          return
        }
        notifications.notify("agent", "Response ready", session.title ?? sessionID, directory, sessionID, `opencode:idle:${directory}:${sessionID}`)
      }))
    }
    if (disposed || refreshes.get(directory) !== token) return
    attention.set(directory, currentAttention)
    if (previousAttention) {
      for (const request of question?.data ?? []) {
        if (previousAttention.questions.has(request.id)) continue
        notifications.notify("agent", "Question", "A background session has a question", directory, request.sessionID, `opencode:question:${directory}:${request.id}`)
      }
      for (const request of permission?.data ?? []) {
        if (previousAttention.permissions.has(request.id)) continue
        notifications.notify("permissions", "Permission required", "A background session needs permission", directory, request.sessionID, `opencode:permission:${directory}:${request.id}`)
      }
    }
    setStatuses((current) => ({
      ...current,
      [directory]: Object.fromEntries(Object.entries(next).concat([...failed].map((sessionID) => [sessionID, previous?.[sessionID] ?? { type: "busy" }]))),
    }))
    if (question) setQuestions((current) => ({ ...current, [directory]: question.data?.length ?? 0 }))
    if (permission) setPermissions((current) => ({ ...current, [directory]: permission.data?.length ?? 0 }))
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

  createEffect(() => {
    const current = directories()
    setStatuses((state) => Object.fromEntries(Object.entries(state).filter(([directory]) => current.has(directory))))
    setQuestions((state) => Object.fromEntries(Object.entries(state).filter(([directory]) => current.has(directory))))
    setPermissions((state) => Object.fromEntries(Object.entries(state).filter(([directory]) => current.has(directory))))
    for (const directory of refreshes.keys()) {
      if (!current.has(directory)) refreshes.delete(directory)
    }
    for (const directory of attention.keys()) if (!current.has(directory)) attention.delete(directory)
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
      badge: (directory) => projectActivityBadge(
        statuses()[directory] ?? {},
        questions()[directory] ?? 0,
        permissions()[directory] ?? 0,
      ),
      setActive,
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
