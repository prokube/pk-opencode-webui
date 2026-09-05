import { batch, createContext, createEffect, createSignal, onCleanup, type ParentProps, untrack, useContext } from "solid-js"
import type { Event, Message, SessionStatus } from "../sdk/client"
import { createOpencodeClient } from "../sdk/client"
import { createEventBuffer } from "../utils/event-buffer"
import { sessionIsWorking } from "../utils/session-tree-request"
import { useBrowserNotifications } from "./browser-notifications"
import { useProjects } from "./projects"
import type { ServerEvent } from "./server-events"
import { useServerEvents } from "./server-events"
import { useServer } from "./server"

type ProjectStatuses = Record<string, Record<string, SessionStatus>>
type ProjectRequests = Record<string, Record<string, string>>

type ProjectActivityState = {
  statuses: ProjectStatuses
  questions: ProjectRequests
  permissions: ProjectRequests
}

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

export function reduceProjectRequests(
  state: ProjectRequests,
  directory: string,
  event: { type: string; properties?: unknown },
  kind: "question" | "permission",
) {
  const asked = `${kind}.asked`
  const removed = kind === "question" ? new Set(["question.replied", "question.rejected"]) : new Set(["permission.replied"])
  const props = event.properties as { id?: string; requestID?: string; sessionID?: string; info?: { id?: string } } | undefined
  const project = state[directory] ?? {}

  if (event.type === asked) {
    if (!props?.id || !props.sessionID || project[props.id] === props.sessionID) return state
    return { ...state, [directory]: { ...project, [props.id]: props.sessionID } }
  }
  if (removed.has(event.type)) {
    if (!props?.requestID || !project[props.requestID]) return state
    const next = { ...project }
    delete next[props.requestID]
    return { ...state, [directory]: next }
  }
  if (event.type !== "session.deleted") return state
  const sessionID = props?.sessionID ?? props?.info?.id
  if (!sessionID || !Object.values(project).includes(sessionID)) return state
  return { ...state, [directory]: Object.fromEntries(Object.entries(project).filter(([, id]) => id !== sessionID)) }
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
  const serverEvents = useServerEvents()
  const notifications = useBrowserNotifications()
  const client = createOpencodeClient({
    baseUrl: server.serverUrl(),
    headers: server.authHeaders(),
    throwOnError: true,
  })
  const [state, setState] = createSignal<ProjectActivityState>({ statuses: {}, questions: {}, permissions: {} })
  const [active, setActiveDirectory] = createSignal<string>()
  const initialized = new Set<string>()
  const refreshes = new Map<string, AbortController>()
  const lifetime = new AbortController()
  const alerted = new Set<string>()
  const errors = new Set<string>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const eventBuffer = createEventBuffer<ServerEvent>(apply)
  let generation = 0
  let activeTimer: ReturnType<typeof setTimeout> | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let retryDelay = 1_000
  let disposed = false

  function directories() {
    return new Set(projects.projects().map((project) => project.worktree))
  }

  function background(directory: string) {
    return directories().has(directory) && directory !== active()
  }

  function requestOptions(controller?: AbortController) {
    const signal = controller
      ? AbortSignal.any([lifetime.signal, controller.signal, AbortSignal.timeout(5_000)])
      : AbortSignal.any([lifetime.signal, AbortSignal.timeout(5_000)])
    return { signal }
  }

  async function rootSessionID(directory: string, sessionID: string) {
    const seen = new Set<string>()
    const current = { id: sessionID }
    while (!seen.has(current.id)) {
      seen.add(current.id)
      const result = await client.session.get({ sessionID: current.id, directory }, requestOptions()).catch(() => undefined)
      if (!result?.data) return
      if (!result.data.parentID) return current.id
      current.id = result.data.parentID
    }
    return sessionID
  }

  function alert(key: string, run: () => void) {
    if (alerted.has(key)) return
    alerted.add(key)
    if (alerted.size > 1000) Array.from(alerted).slice(0, 500).forEach((item) => alerted.delete(item))
    run()
  }

  function resetCompletion(directory: string, sessionID: string) {
    const key = `${directory}:${sessionID}`
    alerted.delete(`idle:${key}`)
    errors.delete(key)
    const timer = timers.get(key)
    if (timer) clearTimeout(timer)
    timers.delete(key)
  }

  function clearDirectory(directory: string) {
    const prefixes = [`idle:${directory}:`, `question:${directory}:`, `permission:${directory}:`]
    for (const key of alerted) if (prefixes.some((prefix) => key.startsWith(prefix))) alerted.delete(key)
    for (const key of errors) if (key.startsWith(`${directory}:`)) errors.delete(key)
    for (const [key, timer] of timers) {
      if (!key.startsWith(`${directory}:`)) continue
      clearTimeout(timer)
      timers.delete(key)
    }
  }

  function clearSession(directory: string, sessionID: string, previous: ProjectActivityState) {
    resetCompletion(directory, sessionID)
    for (const [requestID, id] of Object.entries(previous.questions[directory] ?? {})) {
      if (id === sessionID) alerted.delete(`question:${directory}:${requestID}`)
    }
    for (const [requestID, id] of Object.entries(previous.permissions[directory] ?? {})) {
      if (id === sessionID) alerted.delete(`permission:${directory}:${requestID}`)
    }
  }

  async function notifyCompletion(directory: string, sessionID: string) {
    if (!background(directory)) return
    const [sessionResult, messagesResult] = await Promise.all([
      client.session.get({ sessionID, directory }, requestOptions()).catch(() => undefined),
      client.session.messages({ sessionID, directory }, requestOptions()).catch(() => undefined),
    ])
    const status = state().statuses[directory]?.[sessionID]
    if (!background(directory) || (status && sessionIsWorking(status))) return
    const session = sessionResult?.data
    if (!session || session.parentID || !messagesResult) return
    const assistant = [...(messagesResult.data ?? [])].reverse().find((message) => message.info.role === "assistant")?.info as Message | undefined
    if (assistant?.role === "assistant" && assistant.error?.name === "MessageAbortedError") return
    const title = session.title ?? sessionID
    if (assistant?.role === "assistant" && assistant.error) {
      notifications.notify("errors", "Session error", title, directory, sessionID, `opencode:error:${directory}:${sessionID}`)
      return
    }
    notifications.notify("agent", "Response ready", title, directory, sessionID, `opencode:idle:${directory}:${sessionID}`)
  }

  function scheduleCompletion(directory: string, sessionID: string) {
    const key = `${directory}:${sessionID}`
    if (!background(directory) || timers.has(key)) return
    const timer = setTimeout(() => {
      timers.delete(key)
      if (errors.delete(key)) return
      alert(`idle:${key}`, () => void notifyCompletion(directory, sessionID))
    }, 250)
    timers.set(key, timer)
  }

  async function notifyRequest(directory: string, requestID: string, sessionID: string, kind: "question" | "permission") {
    const requests = () => kind === "question" ? state().questions : state().permissions
    if (!background(directory) || requests()[directory]?.[requestID] !== sessionID) return
    const root = await rootSessionID(directory, sessionID)
    if (!root || !background(directory) || requests()[directory]?.[requestID] !== sessionID) return
    const category = kind === "question" ? "agent" : "permissions"
    const title = kind === "question" ? "Question" : "Permission required"
    const body = kind === "question" ? "A background session has a question" : "A background session needs permission"
    alert(`${kind}:${directory}:${requestID}`, () => {
      notifications.notify(category, title, body, directory, sessionID, `opencode:${kind}:${directory}:${requestID}`, root)
    })
  }

  async function refresh(directory: string, version: number) {
    refreshes.get(directory)?.abort()
    const controller = new AbortController()
    refreshes.set(directory, controller)
    const options = () => requestOptions(controller)
    const [status, questions, permissions] = await Promise.all([
      client.session.status({ directory }, options()).catch(() => undefined),
      client.question.list({ directory }, options()).catch(() => undefined),
      client.permission.list({ directory }, options()).catch(() => undefined),
    ])
    if (disposed || version !== generation || refreshes.get(directory) !== controller || !directories().has(directory)) return true

    const previous = untrack(state)
    const nextStatuses = status?.data ?? previous.statuses[directory] ?? {}
    const nextQuestions = questions
      ? Object.fromEntries((questions.data ?? []).filter((item) => item.id && item.sessionID).map((item) => [item.id, item.sessionID]))
      : previous.questions[directory] ?? {}
    const nextPermissions = permissions
      ? Object.fromEntries((permissions.data ?? []).filter((item) => item.id && item.sessionID).map((item) => [item.id, item.sessionID]))
      : previous.permissions[directory] ?? {}
    const notify = initialized.has(directory) && background(directory)

    batch(() => setState((current) => ({
      statuses: { ...current.statuses, [directory]: nextStatuses },
      questions: { ...current.questions, [directory]: nextQuestions },
      permissions: { ...current.permissions, [directory]: nextPermissions },
    })))
    for (const [sessionID, sessionStatus] of Object.entries(nextStatuses)) {
      if (sessionIsWorking(sessionStatus)) resetCompletion(directory, sessionID)
    }
    const complete = !!status && !!questions && !!permissions
    if (complete) initialized.add(directory)
    if (!notify) return complete

    for (const sessionID of completedSessionIDs(previous.statuses[directory] ?? {}, nextStatuses)) scheduleCompletion(directory, sessionID)
    for (const [requestID, sessionID] of Object.entries(nextQuestions)) {
      if (!previous.questions[directory]?.[requestID]) void notifyRequest(directory, requestID, sessionID, "question")
    }
    for (const [requestID, sessionID] of Object.entries(nextPermissions)) {
      if (!previous.permissions[directory]?.[requestID]) void notifyRequest(directory, requestID, sessionID, "permission")
    }
    return complete
  }

  async function refreshAll(version: number) {
    const pending = [...directories()]
    const complete = { value: true }
    for (let index = 0; index < pending.length; index += 2) {
      if (disposed || version !== generation) return true
      const results = await Promise.all(pending.slice(index, index + 2).map((directory) => refresh(directory, version)))
      if (results.some((result) => !result)) complete.value = false
    }
    return complete.value
  }

  function scheduleRetry() {
    if (retryTimer || disposed) return
    const version = generation
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      startReconciliation(version)
    }, retryDelay)
    retryDelay = Math.min(retryDelay * 2, 30_000)
  }

  function startReconciliation(version: number) {
    if (disposed || version !== generation) return
    void eventBuffer.during(() => refreshAll(version)).then((complete) => {
      if (disposed || version !== generation) return
      if (!complete) {
        scheduleRetry()
        return
      }
      retryDelay = 1_000
      if (retryTimer) clearTimeout(retryTimer)
      retryTimer = undefined
    })
  }

  function restartReconciliation() {
    const version = ++generation
    for (const controller of refreshes.values()) controller.abort()
    refreshes.clear()
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = undefined
    retryDelay = 1_000
    startReconciliation(version)
  }

  function relevant(event: Event) {
    return event.type === "session.status" ||
      event.type === "session.idle" ||
      event.type === "session.deleted" ||
      event.type === "session.error" ||
      event.type.startsWith("question.") ||
      event.type.startsWith("permission.")
  }

  function apply(envelope: ServerEvent) {
    const directory = envelope.directory
    const event = envelope.payload
    if (!directories().has(directory) || !relevant(event)) return

    const before = untrack(state)
    const statuses = reduceProjectActivity(before.statuses, directory, event)
    const questions = reduceProjectRequests(before.questions, directory, event, "question")
    const permissions = reduceProjectRequests(before.permissions, directory, event, "permission")
    if (statuses !== before.statuses || questions !== before.questions || permissions !== before.permissions) {
      setState({ statuses, questions, permissions })
    }

    const props = event.properties as { id?: string; requestID?: string; sessionID?: string; status?: SessionStatus; error?: { name?: string }; info?: { id?: string } }
    const sessionID = props?.sessionID ?? props?.info?.id
    if (event.type === "session.deleted" && sessionID) clearSession(directory, sessionID, before)
    if (!sessionID || !background(directory)) return
    const key = `${directory}:${sessionID}`

    if (event.type === "session.status" && props.status && sessionIsWorking(props.status)) {
      resetCompletion(directory, sessionID)
      return
    }
    if (event.type === "session.idle" || (event.type === "session.status" && props.status?.type === "idle")) {
      scheduleCompletion(directory, sessionID)
      return
    }
    if (event.type === "session.error") {
      errors.add(key)
      if (props.error?.name === "MessageAbortedError") return
      void client.session.get({ sessionID, directory }, requestOptions()).then((result) => {
        if (disposed || !background(directory) || result.data?.parentID) return
        const title = result.data?.title ?? sessionID
        notifications.notify("errors", "Session error", title, directory, sessionID, `opencode:error:${directory}:${sessionID}`)
      }).catch(() => undefined)
      return
    }
    if (event.type === "question.asked" && props.id) {
      void notifyRequest(directory, props.id, sessionID, "question")
      return
    }
    if (event.type === "permission.asked" && props.id) void notifyRequest(directory, props.id, sessionID, "permission")
  }

  const unsubscribe = serverEvents.subscribe((event) => {
    if (directories().has(event.directory) && relevant(event.payload)) eventBuffer.push(event)
  })

  const unsubscribeRecovery = serverEvents.recover(restartReconciliation)

  createEffect(() => {
    const current = directories()
    setState((value) => ({
      statuses: Object.fromEntries(Object.entries(value.statuses).filter(([directory]) => current.has(directory))),
      questions: Object.fromEntries(Object.entries(value.questions).filter(([directory]) => current.has(directory))),
      permissions: Object.fromEntries(Object.entries(value.permissions).filter(([directory]) => current.has(directory))),
    }))
    for (const [directory, controller] of refreshes) {
      if (current.has(directory)) continue
      controller.abort()
      refreshes.delete(directory)
      initialized.delete(directory)
      clearDirectory(directory)
    }
    restartReconciliation()
  })

  onCleanup(() => {
    disposed = true
    unsubscribe()
    unsubscribeRecovery()
    eventBuffer.dispose()
    lifetime.abort()
    if (activeTimer) clearTimeout(activeTimer)
    if (retryTimer) clearTimeout(retryTimer)
    for (const controller of refreshes.values()) controller.abort()
    timers.forEach(clearTimeout)
  })

  return (
    <ProjectActivityContext.Provider value={{
      working: (directory) => Object.values(state().statuses[directory] ?? {}).some(sessionIsWorking),
      badge: (directory) => projectActivityBadge(
        state().statuses[directory] ?? {},
        Object.keys(state().questions[directory] ?? {}).length,
        Object.keys(state().permissions[directory] ?? {}).length,
      ),
      setActive: (directory) => {
        if (activeTimer) clearTimeout(activeTimer)
        activeTimer = undefined
        if (directory) {
          setActiveDirectory(directory)
          return
        }
        activeTimer = setTimeout(() => {
          activeTimer = undefined
          setActiveDirectory(undefined)
        }, 0)
      },
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
