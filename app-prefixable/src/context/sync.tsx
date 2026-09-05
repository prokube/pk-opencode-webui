import { createContext, useContext, createSignal, onCleanup, batch, type ParentProps } from "solid-js"
import { createStore, reconcile, produce } from "solid-js/store"
import type {
  Event,
  Session,
  Message,
  Part,
  ProviderListResponse,
  SessionStatus,
  QuestionRequest,
  PermissionRequest,
} from "../sdk/client"
import { useSDK } from "./sdk"
import { createEventBuffer } from "../utils/event-buffer"
import { useServerEvents } from "./server-events"

type LegacySyncEvent =
  | { type: "message.created"; properties: MessageWithParts }
  | { type: "provider.updated"; properties: ProviderData }

type SyncEvent = Event | LegacySyncEvent

type SyncEventHandler = (event: SyncEvent) => void

export type MessageWithParts = {
  info: Message
  parts: Part[]
}

export type ProviderData = ProviderListResponse

type SyncStore = {
  ready: boolean
  statusReady: boolean
  error: string | null
  session: Session[]
  archivedSession: Session[]
  message: Record<string, MessageWithParts[]>
  part: Record<string, Part[]>
  provider: ProviderData
  status: Record<string, SessionStatus>
  pendingQuestions: Record<string, QuestionRequest[] | undefined>
  pendingPermissions: Record<string, PermissionRequest>
}

export type SyncLiveState = Pick<SyncStore, "status" | "pendingQuestions" | "pendingPermissions">

interface SyncContextValue {
  data: SyncStore
  ready: boolean
  bootstrapError: string | null
  sessions: () => Session[]
  archivedSessions: () => Session[]
  messages: (sessionID: string) => MessageWithParts[]
  parts: (messageID: string) => Part[]
  providers: () => ProviderData
  status: Record<string, SessionStatus>
  statusReady: () => boolean
  pendingQuestions: Record<string, QuestionRequest[] | undefined>
  pendingPermissions: Record<string, PermissionRequest>
  dismissQuestion: (sessionID: string, requestID: string) => void
  setQuestion: (question: QuestionRequest) => void
  dismissSessionStatus: (sessionID: string) => void
  setSessionStatus: (sessionID: string, status: SessionStatus) => void
  dismissPermission: (requestID: string) => void
  setPermission: (permission: PermissionRequest) => void
  sseUnhealthy: () => boolean
  subscribe: (handler: SyncEventHandler) => () => void
  session: {
    sync: (sessionID: string) => Promise<boolean>
    get: (sessionID: string) => Session | undefined
    upsert: (session: Session) => void
    remove: (sessionID: string) => void
    retain: (sessionID: string) => () => void
  }
  provider: {
    invalidate: () => void
    refresh: () => Promise<ProviderData | undefined>
    updateConnected: (providerID: string, connected: boolean) => void
    loading: () => boolean
  }
  refresh: () => Promise<void>
}

const SyncContext = createContext<SyncContextValue>()

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const encoder = new TextEncoder()

export function compareMessages(a: MessageWithParts, b: MessageWithParts) {
  const created = a.info.time.created - b.info.time.created
  return created || cmp(a.info.id, b.info.id)
}

export function upsertQuestion(current: QuestionRequest[] | undefined, question: QuestionRequest) {
  return [...(current ?? []).filter((item) => item.id !== question.id), question].sort((a, b) => cmp(a.id, b.id))
}

export function removeQuestion(current: QuestionRequest[] | undefined, requestID?: string) {
  if (!current) return []
  if (!requestID) return current.slice(1)
  return current.filter((question) => question.id !== requestID)
}

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
  if (!parts) return
  const index = parts.findIndex((part) => part.id === partID)
  if (index === -1) return
  parts[index] = applyPartDelta(parts[index], field, delta)
}

function updateMessagePartInPlace(messages: MessageWithParts[] | undefined, messageID: string, part: Part) {
  if (!messages?.length) return
  const index = messages.findIndex((message) => message.info.id === messageID)
  if (index === -1) return
  messages[index].parts = mergePartUpdate(messages[index].parts, part)
}

function applyMessagePartDeltaInPlace(
  messages: MessageWithParts[] | undefined,
  messageID: string,
  partID: string,
  field: string,
  delta: string,
) {
  if (!messages?.length) return
  const index = messages.findIndex((message) => message.info.id === messageID)
  if (index === -1) return
  applyPartDeltaInPlace(messages[index].parts, partID, field, delta)
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

  return merged.sort(compareMessages)
}

type SessionRequest = {
  sessionID: string
  version: number
  updatedMessages: Set<string>
  updatedParts: Map<string, Set<string>>
  removedMessages: Set<string>
  removedParts: Map<string, Set<string>>
}

type SessionTombstones = {
  messages: Set<string>
  parts: Map<string, Set<string>>
  unknown: boolean
  saturated: boolean
}

export function createSessionRequestTracker(limit = 1000) {
  const versions = new Map<string, number>()
  const requests = new Map<string, Set<SessionRequest>>()
  const tombstones = new Map<string, SessionTombstones>()
  const deleted = new Set<string>()

  function removals(sessionID: string) {
    const existing = tombstones.get(sessionID)
    if (existing) return existing
    const next = { messages: new Set<string>(), parts: new Map<string, Set<string>>(), unknown: false, saturated: false }
    tombstones.set(sessionID, next)
    return next
  }

  function collapse(sessionID: string, state: SessionTombstones) {
    const count = state.messages.size + [...state.parts.values()].reduce((total, parts) => total + parts.size, 0)
    if (count <= limit || state.saturated) return false
    state.unknown = true
    state.saturated = true
    return true
  }

  function invalidate(sessionID: string) {
    versions.set(sessionID, (versions.get(sessionID) ?? 0) + 1)
  }

  function begin(sessionID: string) {
    invalidate(sessionID)
    const request: SessionRequest = {
      sessionID,
      version: versions.get(sessionID)!,
      updatedMessages: new Set(),
      updatedParts: new Map(),
      removedMessages: new Set(),
      removedParts: new Map(),
    }
    const active = requests.get(sessionID) ?? new Set()
    active.add(request)
    requests.set(sessionID, active)
    return request
  }

  function valid(request: SessionRequest) {
    return versions.get(request.sessionID) === request.version
  }

  function removeMessage(sessionID: string, messageID: string) {
    const state = removals(sessionID)
    state.messages.add(messageID)
    state.parts.delete(messageID)
    for (const request of requests.get(sessionID) ?? []) {
      request.removedMessages.add(messageID)
      request.removedParts.delete(messageID)
    }
    return collapse(sessionID, state)
  }

  function removePart(sessionID: string, messageID: string, partID: string) {
    const state = removals(sessionID)
    if (!state.messages.has(messageID)) {
      const parts = state.parts.get(messageID) ?? new Set()
      parts.add(partID)
      state.parts.set(messageID, parts)
    }
    for (const request of requests.get(sessionID) ?? []) {
      if (request.removedMessages.has(messageID)) continue
      const parts = request.removedParts.get(messageID) ?? new Set()
      parts.add(partID)
      request.removedParts.set(messageID, parts)
    }
    return collapse(sessionID, state)
  }

  function updateMessage(sessionID: string, messageID: string) {
    const state = tombstones.get(sessionID)
    if (!state?.unknown) {
      state?.messages.delete(messageID)
      if (state && state.messages.size === 0 && state.parts.size === 0) tombstones.delete(sessionID)
    }
    for (const request of requests.get(sessionID) ?? []) {
      request.removedMessages.delete(messageID)
      request.updatedMessages.add(messageID)
    }
  }

  function touchPart(sessionID: string, messageID: string, partID: string) {
    for (const request of requests.get(sessionID) ?? []) {
      const parts = request.updatedParts.get(messageID) ?? new Set()
      parts.add(partID)
      request.updatedParts.set(messageID, parts)
    }
  }

  function updatePart(sessionID: string, messageID: string, partID: string) {
    const state = tombstones.get(sessionID)
    if (!state?.unknown) {
      state?.parts.get(messageID)?.delete(partID)
      if (state?.parts.get(messageID)?.size === 0) state.parts.delete(messageID)
      if (state && state.messages.size === 0 && state.parts.size === 0) tombstones.delete(sessionID)
    }
    for (const request of requests.get(sessionID) ?? []) {
      request.removedParts.get(messageID)?.delete(partID)
      if (request.removedParts.get(messageID)?.size === 0) request.removedParts.delete(messageID)
    }
    touchPart(sessionID, messageID, partID)
  }

  function requireSnapshot(sessionID: string) {
    const state = removals(sessionID)
    state.unknown = true
  }

  function filter(request: SessionRequest, messages: MessageWithParts[]) {
    const state = tombstones.get(request.sessionID)
    if (!state) return messages
    return messages
      .filter((message) => !state.messages.has(message.info.id) && !request.removedMessages.has(message.info.id))
      .map((message) => ({
        ...message,
        parts: message.parts.filter((part) =>
          !state.parts.get(message.info.id)?.has(part.id) && !request.removedParts.get(message.info.id)?.has(part.id)),
      }))
  }

  function snapshot(request: SessionRequest, existing: MessageWithParts[] | undefined, messages: MessageWithParts[]) {
    const current = existing ?? []
    const currentByID = new Map(current.map((message) => [message.info.id, message]))
    const state = tombstones.get(request.sessionID)
    const next = filter(request, messages).map((message) => {
      const cached = currentByID.get(message.info.id)
      if (!cached) return message
      if (request.updatedMessages.has(message.info.id)) return cached
      const updated = request.updatedParts.get(message.info.id)
      if (!updated) return message
      const cachedParts = new Map(cached.parts.map((part) => [part.id, part]))
      const parts = message.parts.map((part) => updated.has(part.id)
        ? cachedParts.get(part.id) ?? part
        : part)
      const partIDs = new Set(parts.map((part) => part.id))
      for (const part of cached.parts) {
        if (state?.parts.get(message.info.id)?.has(part.id) || request.removedParts.get(message.info.id)?.has(part.id)) continue
        if (!updated.has(part.id) || partIDs.has(part.id)) continue
        parts.push(part)
        partIDs.add(part.id)
      }
      return {
        ...message,
        parts: sortParts(parts),
      }
    })
    const nextIDs = new Set(next.map((message) => message.info.id))
    for (const message of current) {
      if (state?.messages.has(message.info.id) || request.removedMessages.has(message.info.id)) continue
      if (!request.updatedMessages.has(message.info.id) && !request.updatedParts.has(message.info.id)) continue
      if (nextIDs.has(message.info.id)) continue
      next.push(message)
      nextIDs.add(message.info.id)
    }
    return next.sort(compareMessages)
  }

  function appliedSnapshot(sessionID: string) {
    const state = tombstones.get(sessionID)
    if (state) state.unknown = false
  }

  function needsSnapshot(sessionID: string) {
    return tombstones.get(sessionID)?.unknown === true
  }

  function removeSession(sessionID: string) {
    tombstones.delete(sessionID)
    deleted.add(sessionID)
    invalidate(sessionID)
    if (requests.get(sessionID)?.size) return
    versions.delete(sessionID)
    deleted.delete(sessionID)
  }

  function restore(sessionID: string) {
    if (!deleted.delete(sessionID)) return
    invalidate(sessionID)
  }

  function end(request: SessionRequest) {
    const active = requests.get(request.sessionID)
    active?.delete(request)
    if (active?.size === 0) requests.delete(request.sessionID)
    if (!deleted.has(request.sessionID) || requests.has(request.sessionID)) return
    versions.delete(request.sessionID)
    deleted.delete(request.sessionID)
  }

  function evict(sessionID: string) {
    if (requests.get(sessionID)?.size) return false
    tombstones.delete(sessionID)
    versions.delete(sessionID)
    deleted.delete(sessionID)
    return true
  }

  return {
    appliedSnapshot,
    begin,
    end,
    evict,
    filter,
    invalidate,
    needsSnapshot,
    removeMessage,
    removePart,
    removeSession,
    requireSnapshot,
    restore,
    snapshot,
    touchPart,
    updateMessage,
    updatePart,
    valid,
  }
}

export function coalesceSyncEvent(previous: SyncEvent, event: SyncEvent) {
  if (previous.type !== "message.part.delta" || event.type !== "message.part.delta") return undefined
  const before = previous.properties
  const next = event.properties
  if (
    before.sessionID !== next.sessionID ||
    before.messageID !== next.messageID ||
    before.partID !== next.partID ||
    before.field !== next.field
  ) return undefined
  return { ...event, properties: { ...next, delta: before.delta + next.delta } }
}

export function syncEventSize(event: SyncEvent) {
  const value = event.type === "message.part.delta" ? event.properties.delta : JSON.stringify(event)
  return encoder.encode(value).byteLength
}

export function updateProviderConnected(data: ProviderData, providerID: string, connected: boolean) {
  const current = data.connected.includes(providerID)
  if (current === connected) return data
  return {
    ...data,
    connected: connected ? [...data.connected, providerID] : data.connected.filter((id) => id !== providerID),
  }
}

export function createLatestSuccessfulRequest() {
  let requested = 0
  let applied = 0
  return {
    begin: () => ++requested,
    apply: (version: number, update: () => void) => {
      if (version <= applied) return false
      applied = version
      update()
      return true
    },
    invalidate: () => {
      applied = ++requested
    },
  }
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
  const index = current.findIndex((message) => message.info.id === info.id)
  const parts = messageUpdateParts(current, index >= 0 ? index : undefined, knownParts, eventParts)
  const next = { info, parts }

  if (index >= 0) return current.map((m, i) => (i === index ? next : m)).sort(compareMessages)
  return [...current, next].sort(compareMessages)
}

export function removeMessageByID(messages: MessageWithParts[] | undefined, messageID: string) {
  return messages?.filter((message) => message.info.id !== messageID) ?? []
}

export function removePartByID(parts: Part[] | undefined, partID: string) {
  return parts?.filter((part) => part.id !== partID) ?? []
}

function eventInfo<T>(props: Record<string, unknown>) {
  return (props.info ?? props) as T
}

export function reduceSyncLiveEvent(
  state: SyncLiveState,
  event: { type: string; properties?: unknown },
): SyncLiveState {
  const props = event.properties as Record<string, unknown> | undefined

  if (event.type === "session.status") {
    const sessionID = props?.sessionID
    const status = props?.status
    if (typeof sessionID !== "string" || !status) return state
    return { ...state, status: { ...state.status, [sessionID]: status as SessionStatus } }
  }

  if (event.type === "session.idle") {
    const sessionID = props?.sessionID
    if (typeof sessionID !== "string") return state
    return { ...state, status: { ...state.status, [sessionID]: { type: "idle" } } }
  }

  if (event.type === "question.asked") {
    const question = event.properties as QuestionRequest
    if (!question?.id || !question.sessionID) return state
    return {
      ...state,
      pendingQuestions: {
        ...state.pendingQuestions,
        [question.sessionID]: upsertQuestion(state.pendingQuestions[question.sessionID], question),
      },
    }
  }

  if (event.type === "question.replied" || event.type === "question.rejected") {
    const sessionID = props?.sessionID
    const requestID = props?.requestID
    if (typeof sessionID !== "string") return state
    const current = state.pendingQuestions[sessionID]
    if (!current) return state
    if (typeof requestID === "string" && !current.some((question) => question.id === requestID)) return state
    const next = removeQuestion(current, typeof requestID === "string" ? requestID : undefined)
    const pendingQuestions = { ...state.pendingQuestions }
    if (next.length) pendingQuestions[sessionID] = next
    if (!next.length) delete pendingQuestions[sessionID]
    return { ...state, pendingQuestions }
  }

  if (event.type === "permission.asked") {
    const permission = event.properties as PermissionRequest
    if (!permission?.id || !permission.sessionID) return state
    return {
      ...state,
      pendingPermissions: { ...state.pendingPermissions, [permission.id]: permission },
    }
  }

  if (event.type === "permission.replied") {
    const requestID = props?.requestID
    if (typeof requestID !== "string" || !state.pendingPermissions[requestID]) return state
    const pendingPermissions = { ...state.pendingPermissions }
    delete pendingPermissions[requestID]
    return { ...state, pendingPermissions }
  }

  return state
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

export type SyncSessionState = Pick<SyncStore, "session" | "archivedSession">
export type SyncSessionData = Pick<
  SyncStore,
  "session" | "archivedSession" | "message" | "part" | "status" | "pendingQuestions" | "pendingPermissions"
>

export function upsertSyncSession(state: SyncSessionState, session: Session): SyncSessionState {
  const archived = !!session.time?.archived
  const insert = (sessions: Session[]) => {
    const next = sessions.filter((item) => item.id !== session.id)
    const match = binarySearch(next, session.id, (item) => item.id)
    next.splice(match.index, 0, session)
    return next
  }

  return {
    session: archived ? state.session.filter((item) => item.id !== session.id) : insert(state.session),
    archivedSession: archived
      ? insert(state.archivedSession)
      : state.archivedSession.filter((item) => item.id !== session.id),
  }
}

export function removeSyncSession(state: SyncSessionState, sessionID: string): SyncSessionState {
  return {
    session: state.session.filter((session) => session.id !== sessionID),
    archivedSession: state.archivedSession.filter((session) => session.id !== sessionID),
  }
}

export function removeSyncSessionData(state: SyncSessionData, sessionID: string): SyncSessionData {
  const sessions = removeSyncSession(state, sessionID)
  const messageIDs = new Set((state.message[sessionID] ?? []).map((message) => message.info.id))
  return {
    ...sessions,
    message: Object.fromEntries(Object.entries(state.message).filter(([id]) => id !== sessionID)),
    part: Object.fromEntries(
      Object.entries(state.part).filter(([messageID, parts]) =>
        !messageIDs.has(messageID) && !parts.some((part) => part.sessionID === sessionID)),
    ),
    status: Object.fromEntries(Object.entries(state.status).filter(([id]) => id !== sessionID)),
    pendingQuestions: Object.fromEntries(Object.entries(state.pendingQuestions).filter(([id]) => id !== sessionID)),
    pendingPermissions: Object.fromEntries(
      Object.entries(state.pendingPermissions).filter(([, permission]) => permission.sessionID !== sessionID),
    ),
  }
}

export function SyncProvider(props: ParentProps) {
  const { client, directory } = useSDK()
  const serverEvents = useServerEvents()

  const [store, setStore] = createStore<SyncStore>({
    ready: false,
    statusReady: !directory,
    error: null,
    session: [],
    archivedSession: [],
    message: {},
    part: {},
    provider: { all: [], connected: [], default: {} },
    status: {},
    pendingQuestions: {},
    pendingPermissions: {},
  })

  const inflight = new Map<string, Promise<boolean>>()
  const sessionCacheAccess = new Map<string, number>()
  const retainedSessions = new Map<string, number>()
  const sessionRequests = createSessionRequestTracker()
  const handlers = new Set<SyncEventHandler>()
  const [providerLoading, setProviderLoading] = createSignal(false)
  const overflowSessions = new Set<string>()
  const overflowDeleted = new Set<string>()
  let overflowGlobal = false
  const events = createEventBuffer<SyncEvent>(handleEvent, {
    coalesce: coalesceSyncEvent,
    byteLimit: 1024 * 1024,
    size: syncEventSize,
    overflow: (event) => {
      const props = event.properties as Record<string, unknown>
      const sessionID = event.type === "message.part.updated"
        ? (props.part as Part | undefined)?.sessionID
        : event.type === "message.updated" || event.type === "message.created"
          ? eventInfo<Message>(props)?.sessionID
          : event.type.startsWith("session.")
            ? eventInfo<Session>(props)?.id
            : typeof props.sessionID === "string"
              ? props.sessionID
              : undefined
      if (event.type.startsWith("message.") && sessionID) {
        sessionRequests.requireSnapshot(sessionID)
        overflowSessions.add(sessionID)
        return
      }
      if (event.type === "session.deleted" && sessionID) overflowDeleted.add(sessionID)
      overflowGlobal = true
    },
    released: (overflowed) => {
      if (disposed) return
      if (!overflowed) return
      const sessions = [...overflowSessions]
      overflowSessions.clear()
      const deleted = new Set(overflowDeleted)
      for (const sessionID of deleted) removeSession(sessionID)
      overflowDeleted.clear()
      for (const sessionID of sessions) {
        if (!deleted.has(sessionID)) void resyncSession(sessionID)
      }
      if (!overflowGlobal) return
      overflowGlobal = false
      if (bootstrapPromise) {
        reconnectBootstrapPending = true
        return
      }
      void bootstrap()
    },
  })
  let bootstrapPromise: Promise<void> | undefined
  let reconnectBootstrapPending = false
  let bootstrapRetryTimer: ReturnType<typeof setTimeout> | undefined
  let bootstrapRetryDelay = 1000
  let disposed = false
  let providerRequests = 0
  let recoveryPending = false
  let recovery: Promise<void> | undefined
  const providerRefresh = createLatestSuccessfulRequest()

  function applySessions(next: SyncSessionState) {
    batch(() => {
      setStore("session", reconcile(next.session, { key: "id" }))
      setStore("archivedSession", reconcile(next.archivedSession, { key: "id" }))
    })
  }

  function applySession(session: Session) {
    applySessions(upsertSyncSession(store, session))
  }

  function upsertSession(session: Session) {
    sessionRequests.restore(session.id)
    applySession(session)
  }

  function removeSession(sessionID: string) {
    sessionCacheAccess.delete(sessionID)
    sessionRequests.removeSession(sessionID)
    const next = removeSyncSessionData(store, sessionID)
    batch(() => {
      applySessions(next)
      setStore("message", reconcile(next.message))
      setStore("part", reconcile(next.part))
      setStore("status", reconcile(next.status))
      setStore("pendingQuestions", reconcile(next.pendingQuestions))
      setStore("pendingPermissions", reconcile(next.pendingPermissions))
    })
  }

  function touchSessionCache(sessionID: string) {
    sessionCacheAccess.delete(sessionID)
    sessionCacheAccess.set(sessionID, Date.now())
  }

  function evictSessionCaches(current: string) {
    while (sessionCacheAccess.size > 40) {
      const candidate = [...sessionCacheAccess.keys()].find((sessionID) => {
        if (sessionID === current) return false
        if ((retainedSessions.get(sessionID) ?? 0) > 0) return false
        const status = store.status[sessionID]?.type
        if (status === "busy" || status === "retry") return false
        if (store.pendingQuestions[sessionID]?.length) return false
        return !Object.values(store.pendingPermissions).some((permission) => permission.sessionID === sessionID)
      })
      if (!candidate) return
      if (!sessionRequests.evict(candidate)) return
      sessionCacheAccess.delete(candidate)
      const messageIDs = new Set((store.message[candidate] ?? []).map((message) => message.info.id))
      setStore("message", produce((messages) => {
        delete messages[candidate]
      }))
      setStore("part", produce((parts) => {
        for (const [messageID, items] of Object.entries(parts)) {
          if (messageIDs.has(messageID) || items.some((part) => part.sessionID === candidate)) delete parts[messageID]
        }
      }))
    }
  }

  function resyncSession(sessionID: string) {
    return syncSession(sessionID, true)
  }

  function handleEvent(event: SyncEvent) {
    if (disposed) return
    const props = event.properties

    const currentLive = {
      status: store.status,
      pendingQuestions: store.pendingQuestions,
      pendingPermissions: store.pendingPermissions,
    }
    const live = directory ? reduceSyncLiveEvent(currentLive, event) : currentLive
    batch(() => {
      if (live.status !== store.status) setStore("status", reconcile(live.status))
      if (live.pendingQuestions !== store.pendingQuestions) {
        setStore("pendingQuestions", reconcile(live.pendingQuestions))
      }
      if (live.pendingPermissions !== store.pendingPermissions) {
        setStore("pendingPermissions", reconcile(live.pendingPermissions))
      }
      if (directory && (event.type === "session.status" || event.type === "session.idle")) setStore("statusReady", true)
    })

    // Session events
    if (event.type === "session.created") {
      const session = eventInfo<Session>(props)
      if (!session?.id) return
      upsertSession(session)
    }

    if (event.type === "session.updated") {
      const session = eventInfo<Session>(props)
      if (!session?.id) return
      const pending = inflight.get(session.id)
      sessionRequests.invalidate(session.id)
      upsertSession(session)
      pending?.finally(() => queueMicrotask(() => {
        if (!inflight.has(session.id)) void syncSession(session.id)
      }))
    }

    if (event.type === "session.deleted") {
      const session = eventInfo<Session>(props)
      if (!session?.id) return
      removeSession(session.id)
    }

    if (event.type === "message.removed") {
      const removed = props as { sessionID?: string; messageID?: string }
      if (!removed.sessionID || !removed.messageID) return
      const resync = sessionRequests.removeMessage(removed.sessionID, removed.messageID)
      setStore("message", removed.sessionID, (messages: MessageWithParts[] | undefined) =>
        removeMessageByID(messages, removed.messageID!),
      )
      setStore("part", produce((parts) => {
        delete parts[removed.messageID!]
      }))
      if (resync) void resyncSession(removed.sessionID)
    }

    if (event.type === "message.part.removed") {
      const removed = props as { sessionID?: string; messageID?: string; partID?: string }
      if (!removed.sessionID || !removed.messageID || !removed.partID) return
      const resync = sessionRequests.removePart(removed.sessionID, removed.messageID, removed.partID)
      setStore("part", removed.messageID, (parts: Part[] | undefined) =>
        removePartByID(parts, removed.partID!),
      )
      setStore("message", removed.sessionID, (messages: MessageWithParts[] | undefined) =>
        messages?.map((message) => message.info.id === removed.messageID
          ? { ...message, parts: removePartByID(message.parts, removed.partID!) }
          : message) ?? [],
      )
      if (resync) void resyncSession(removed.sessionID)
    }

    // Message part events - the main real-time update mechanism
    if (event.type === "message.part.updated") {
      const part = event.properties.part
      if (!part?.sessionID || !part?.messageID) return
      if (!store.message[part.sessionID] && !inflight.has(part.sessionID)) return
      sessionRequests.updatePart(part.sessionID, part.messageID, part.id)

      // Update or insert the part
      setStore("part", part.messageID, (existing: Part[] | undefined) => mergePartUpdate(existing, part))

      // Update parts in existing messages only - don't synthesize messages from parts
      if (store.message[part.sessionID]) {
        setStore("message", part.sessionID, produce((messages: MessageWithParts[]) => {
          updateMessagePartInPlace(messages, part.messageID, part)
        }))
      }
      touchSessionCache(part.sessionID)
      evictSessionCaches(part.sessionID)
    }

    if (event.type === "message.part.delta") {
      const delta = props as { sessionID?: string; messageID?: string; partID?: string; field?: string; delta?: string }
      if (!delta.sessionID || !delta.messageID || !delta.partID || !delta.field || delta.delta === undefined) return
      if (!store.message[delta.sessionID] && !inflight.has(delta.sessionID)) return
      const field = delta.field
      const text = delta.delta
      sessionRequests.touchPart(delta.sessionID, delta.messageID, delta.partID)

      if (store.part[delta.messageID]) {
        setStore("part", delta.messageID, produce((parts: Part[]) => {
          applyPartDeltaInPlace(parts, delta.partID!, field, text)
        }))
      }

      if (store.message[delta.sessionID]) {
        setStore("message", delta.sessionID, produce((messages: MessageWithParts[]) => {
          applyMessagePartDeltaInPlace(messages, delta.messageID!, delta.partID!, field, text)
        }))
      }
      touchSessionCache(delta.sessionID)
      evictSessionCaches(delta.sessionID)
    }

    // Message created event
    if (event.type === "message.created") {
      const msg = props as unknown as MessageWithParts
      if (!msg?.info?.sessionID) return
      sessionRequests.updateMessage(msg.info.sessionID, msg.info.id)
      for (const part of msg.parts ?? []) sessionRequests.updatePart(msg.info.sessionID, msg.info.id, part.id)

      setStore("message", msg.info.sessionID, (existing: MessageWithParts[]) => {
        if (!existing || existing.length === 0) return [msg]
        if (existing.some((message) => message.info.id === msg.info.id)) return existing
        return [...existing, msg].sort(compareMessages)
      })

      if (msg.parts) {
        setStore("part", msg.info.id, sortParts(msg.parts))
      }
      touchSessionCache(msg.info.sessionID)
      evictSessionCaches(msg.info.sessionID)
    }

    // Message updated event
    if (event.type === "message.updated") {
      const msgProps = props as { info?: Message; parts?: Part[] }
      const info = eventInfo<Message>(props)
      const parts = msgProps.parts
      if (!info?.sessionID) return
      sessionRequests.updateMessage(info.sessionID, info.id)
      for (const part of parts ?? []) sessionRequests.updatePart(info.sessionID, info.id, part.id)

      setStore("message", info.sessionID, (existing: MessageWithParts[] | undefined) =>
        mergeMessageUpdate(existing, info, store.part[info.id], parts),
      )

      // Also update parts store if parts were provided
      if (parts && info.id) {
        setStore("part", info.id, sortParts(parts))
      }
      touchSessionCache(info.sessionID)
      evictSessionCaches(info.sessionID)
    }

    // Provider events
    if (event.type === "provider.updated") {
      const data = props as unknown as ProviderData
      if (data) {
        providerRefresh.invalidate()
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

  function bootstrap() {
    if (disposed) return Promise.resolve()
    if (bootstrapPromise) return bootstrapPromise
    const providerVersion = providerRefresh.begin()

    const promise = events.during(async () => {
      setStore("error", null)
      const statusRequest = directory ? client.session.status({ directory }) : Promise.resolve(undefined)
      const questionRequest = directory ? client.question.list({ directory }) : Promise.resolve(undefined)
      const permissionRequest = directory ? client.permission.list({ directory }) : Promise.resolve(undefined)
      const [sessionsResult, providersResult, statusResult, questionsResult, permissionsResult] = await Promise.allSettled([
        client.session.list(),
        client.provider.list(),
        statusRequest,
        questionRequest,
        permissionRequest,
      ])
      if (disposed) return

      let listedSessions: Set<string> | undefined
      batch(() => {
        if (sessionsResult.status === "fulfilled") {
          const sessionsRes = sessionsResult.value
          const rawSessions = sessionsRes.data ?? []
          const valid = rawSessions.filter((s: Session | undefined): s is Session => !!s?.id)
          const sessions = valid.filter((s) => !s.time?.archived).sort((a, b) => cmp(a.id, b.id))
          const archived = valid.filter((s) => !!s.time?.archived).sort((a, b) => cmp(a.id, b.id))
          listedSessions = new Set(valid.map((session) => session.id))
          setStore("session", reconcile(sessions, { key: "id" }))
          setStore("archivedSession", reconcile(archived, { key: "id" }))
        }

        if (providersResult.status === "fulfilled") {
          const providersRes = providersResult.value
          if (providersRes.data) {
            providerRefresh.apply(providerVersion, () => {
              setStore("provider", providersRes.data as unknown as ProviderData)
            })
          }
        }

        if (statusResult.status === "fulfilled") {
          const statuses = statusResult.value?.data ?? {}
          setStore("status", reconcile(statuses as Record<string, SessionStatus>))
        }

        if (questionsResult.status === "fulfilled") {
          const questions = questionsResult.value?.data ?? []
          const pending = questions
            .filter((question) => !!question?.id && !!question.sessionID)
            .reduce<Record<string, QuestionRequest[]>>((result, question) => {
              result[question.sessionID] = upsertQuestion(result[question.sessionID], question)
              return result
            }, {})
          setStore("pendingQuestions", reconcile(pending))
        }

        if (permissionsResult.status === "fulfilled") {
          const permissions = permissionsResult.value?.data ?? []
          const pending = Object.fromEntries(
            permissions.filter((permission) => !!permission?.id).map((permission) => [permission.id, permission]),
          )
          setStore("pendingPermissions", reconcile(pending))
        }

        if (statusResult.status === "fulfilled") setStore("statusReady", true)
        setStore("ready", true)

        const coreError = sessionsResult.status === "rejected"
          ? sessionsResult.reason
          : providersResult.status === "rejected"
            ? providersResult.reason
            : undefined
        if (coreError) setStore("error", errorText(coreError))
      })

      if (listedSessions) {
        for (const sessionID of Object.keys(store.message)) {
          if (!listedSessions.has(sessionID)) removeSession(sessionID)
        }
      }

      if (sessionsResult.status === "rejected") console.error("[Sync] Failed to load sessions:", sessionsResult.reason)
      if (providersResult.status === "rejected") console.error("[Sync] Failed to load providers:", providersResult.reason)
      if (statusResult.status === "rejected") console.error("[Sync] Failed to load statuses:", statusResult.reason)
      if (questionsResult.status === "rejected") console.error("[Sync] Failed to load questions:", questionsResult.reason)
      if (permissionsResult.status === "rejected") console.error("[Sync] Failed to load permissions:", permissionsResult.reason)

      const failed = [sessionsResult, providersResult, statusResult, questionsResult, permissionsResult]
        .some((result) => result.status === "rejected")
      if (failed && !bootstrapRetryTimer) {
        bootstrapRetryTimer = setTimeout(() => {
          bootstrapRetryTimer = undefined
          void bootstrap()
        }, bootstrapRetryDelay)
        bootstrapRetryDelay = Math.min(bootstrapRetryDelay * 2, 30_000)
      }
      if (!failed) {
        bootstrapRetryDelay = 1000
        if (bootstrapRetryTimer) clearTimeout(bootstrapRetryTimer)
        bootstrapRetryTimer = undefined
      }

      console.log("[Sync] Bootstrap complete, sessions:", store.session.length)
    })

    bootstrapPromise = promise
    promise.finally(() => {
      if (bootstrapPromise !== promise) return
      bootstrapPromise = undefined
      if (!reconnectBootstrapPending) return
      reconnectBootstrapPending = false
      void recoverAfterReconnect()
    })
    return promise
  }


  async function recoverAfterReconnect() {
    if (disposed) return
    await bootstrap()
    await Promise.all(Object.keys(store.message).map((sessionID) => resyncSession(sessionID)))
  }

  async function refreshProvider() {
    const version = providerRefresh.begin()
    providerRequests += 1
    setProviderLoading(true)
    try {
      const res = await client.provider.list()
      if (!res.data) return undefined
      const applied = providerRefresh.apply(version, () => setStore("provider", reconcile(res.data!)))
      return applied ? res.data : store.provider
    } catch (err) {
      console.error("[Sync] Failed to load providers:", err)
      return undefined
    } finally {
      providerRequests -= 1
      if (providerRequests === 0) setProviderLoading(false)
    }
  }

  async function syncSession(sessionID: string, replace = false) {
    if (disposed) return false
    const current = inflight.get(sessionID)
    if (current && !replace && !sessionRequests.needsSnapshot(sessionID)) return current
    const request = sessionRequests.begin(sessionID)

    const promise = (async () => {
      try {
        const [sessionRes, messagesRes] = await Promise.all([
          client.session.get({ sessionID }),
          client.session.messages({ sessionID }),
        ])
        if (!sessionRequests.valid(request)) return true

        batch(() => {
          // Update session in appropriate list and remove from other list
          if (sessionRes.data) {
            applySession(sessionRes.data)
          }

          // Merge messages - preserve newer SSE updates
          if (messagesRes.data) {
            const synced = sessionRequests.filter(request, messagesRes.data as MessageWithParts[])
              .filter((m): m is MessageWithParts => !!m?.info?.id)
              .sort(compareMessages)

            const snapshot = sessionRequests.snapshot(request, store.message[sessionID], synced)
            const oldMessageIDs = new Set((store.message[sessionID] ?? []).map((message) => message.info.id))
            const messageIDs = new Set(snapshot.map((message) => message.info.id))
            setStore("message", sessionID, reconcile(snapshot))
            setStore("part", produce((parts) => {
              for (const [messageID, items] of Object.entries(parts)) {
                if (oldMessageIDs.has(messageID) || messageIDs.has(messageID) || items.some((part) => part.sessionID === sessionID)) {
                  delete parts[messageID]
                }
              }
              for (const message of snapshot) parts[message.info.id] = sortParts(message.parts)
            }))
            sessionRequests.appliedSnapshot(sessionID)
            touchSessionCache(sessionID)
            evictSessionCaches(sessionID)
          }
        })
        return true
      } catch (err) {
        console.error("[Sync] Failed to sync session:", sessionID, err)
        return false
      }
    })()

    inflight.set(sessionID, promise)
    promise.finally(() => {
      sessionRequests.end(request)
      if (inflight.get(sessionID) === promise) inflight.delete(sessionID)
    })
    return promise
  }

  const refresh = () => bootstrap()

  const unsubscribe = serverEvents.subscribe((envelope) => {
    if (envelope.directory !== "global" && envelope.directory !== directory) return
    const event = envelope.payload as SyncEvent
    events.push(event)
  })

  function requestRecovery(_reason: "connected" | "overflow") {
    if (recovery) {
      recoveryPending = true
      return
    }
    const promise = events.during(recoverAfterReconnect)
    recovery = promise
    void promise.finally(() => {
      if (recovery !== promise) return
      recovery = undefined
      if (!recoveryPending || disposed) return
      recoveryPending = false
      requestRecovery("overflow")
    })
  }

  const unsubscribeRecovery = serverEvents.recover(requestRecovery)

  // REST state must not wait for the SSE response or handshake.
  bootstrap()

  onCleanup(() => {
    disposed = true
    events.dispose()
    unsubscribe()
    unsubscribeRecovery()
    if (bootstrapRetryTimer) clearTimeout(bootstrapRetryTimer)
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
    get status() {
      return store.status
    },
    statusReady: () => store.statusReady,
    get pendingQuestions() {
      return store.pendingQuestions
    },
    get pendingPermissions() {
      return store.pendingPermissions
    },
    dismissQuestion: (sessionID: string, requestID: string) => {
      const next = removeQuestion(store.pendingQuestions[sessionID], requestID)
      setStore("pendingQuestions", produce((pending) => {
        if (next.length) pending[sessionID] = next
        if (!next.length) delete pending[sessionID]
      }))
    },
    setQuestion: (question: QuestionRequest) => setStore(
      "pendingQuestions",
      question.sessionID,
      upsertQuestion(store.pendingQuestions[question.sessionID], question),
    ),
    dismissSessionStatus: (sessionID: string) => {
      if (!store.status[sessionID]) return
      setStore("status", produce((status) => {
        delete status[sessionID]
      }))
    },
    setSessionStatus: (sessionID: string, status: SessionStatus) => setStore("status", sessionID, status),
    dismissPermission: (requestID: string) => {
      if (!store.pendingPermissions[requestID]) return
      setStore("pendingPermissions", produce((pending) => {
        delete pending[requestID]
      }))
    },
    setPermission: (permission: PermissionRequest) => setStore("pendingPermissions", permission.id, permission),
    sseUnhealthy: serverEvents.unhealthy,
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
      upsert: upsertSession,
      remove: removeSession,
      retain: (sessionID: string) => {
        retainedSessions.set(sessionID, (retainedSessions.get(sessionID) ?? 0) + 1)
        return () => {
          const next = (retainedSessions.get(sessionID) ?? 1) - 1
          if (next > 0) retainedSessions.set(sessionID, next)
          if (next <= 0) retainedSessions.delete(sessionID)
        }
      },
    },
    provider: {
      invalidate: () => {
        providerRefresh.invalidate()
      },
      refresh: refreshProvider,
      updateConnected: (providerID: string, connected: boolean) => {
        providerRefresh.invalidate()
        setStore("provider", updateProviderConnected(store.provider, providerID, connected))
      },
      loading: providerLoading,
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
