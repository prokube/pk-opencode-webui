import { createTelegramSessionStore, telegramSessionKey, type TelegramPendingQuestion } from "./telegram-session-store"
import { loadTelegramBridgeSettings, writeTelegramRuntimeState } from "./telegram-settings"

type TelegramUpdate = {
  update_id: number
  message?: {
    message_id: number
    text?: string
    chat?: {
      id: number
    }
    from?: {
      id: number
    }
  }
  callback_query?: {
    id: string
    data?: string
    from?: {
      id: number
    }
    message?: {
      message_id: number
      chat?: {
        id: number
      }
    }
  }
}

type BridgeConfig = {
  mode: "polling" | "webhook"
  token: string
  openCodeUrl: string
  multiSourceEnabled?: boolean
  sources?: Array<{
    id: string
    openCodeUrl: string
    enabled: boolean
    directory?: string
  }>
  sessionLinkBase?: string
  directory?: string
  sessionCacheMax: number
  sessionCacheTtlMs: number
  notificationDebounceMs: number
  telegramAlarmChannelEnabled?: boolean
  port: number
  webhookPath: string
  webhookSecret?: string
  webhookUrl?: string
  sessionStorePath: string
}

type Runtime = {
  config: BridgeConfig
  sources?: SourceConfig[]
  sourceById?: Map<string, SourceConfig>
  defaultSourceId?: string
  store: ReturnType<typeof createTelegramSessionStore>
}

type SourceConfig = {
  id: string
  openCodeUrl: string
  directory?: string
  enabled: boolean
}

type BridgeHealthState = "healthy" | "degraded"

type BridgeHealthCheck = {
  status: "ok" | "error"
  message: string
}

type BridgeHealthReport = {
  status: BridgeHealthState
  checkedAt: string
  process: {
    status: "up"
    pid: number
    uptimeSec: number
    mode: "polling" | "webhook"
  }
  config: {
    status: "ok"
    tokenConfigured: boolean
    webhookSecretConfigured: boolean
    openCodeUrlConfigured: boolean
    sessionStorePathConfigured: boolean
    directoryConfigured: boolean
    mode: "polling" | "webhook"
  }
  dependencies: {
    telegramApi: BridgeHealthCheck
    openCodeApi: BridgeHealthCheck
    openCodeSources?: Array<{ sourceId: string } & BridgeHealthCheck>
  }
}

type TelegramPendingItem = {
  id: string
  kind: "question" | "permission" | "task-finished"
  sessionId: string
  sourceId?: string
  text: string
  stampedAt: number
  resolved: boolean
}

type CachedSession = {
  id: string
  expiresAt: number
}

type CachedSessionInfo = {
  exists: boolean
  title: string | null
  expiresAt: number
}

function healthAccessPublic() {
  const value = (process.env.TELEGRAM_HEALTH_PUBLIC || "").trim().toLowerCase()
  if (value === "1") return true
  if (value === "true") return true
  if (value === "yes") return true
  return false
}

export function telegramHealthHost(mode: BridgeConfig["mode"]): string {
  if (mode === "polling" && !healthAccessPublic()) return "127.0.0.1"
  return "0.0.0.0"
}

function isLocalAddress(value: string | undefined): boolean {
  if (!value) return false
  if (value === "127.0.0.1") return true
  if (value === "::1") return true
  if (value === "::ffff:127.0.0.1") return true
  return false
}

export function allowTelegramHealthRequest(address: string | undefined): boolean {
  if (healthAccessPublic()) return true
  return isLocalAddress(address)
}

type TelegramCommand = {
  name: string
  text: string
  args?: string
}

type SavedPrompt = {
  id: string
  title: string
  text: string
  createdAt: number
  scope: "global" | "project"
}

type SessionRef = {
  sourceId: string
  sessionId: string
}

function defaultSource(config: BridgeConfig): SourceConfig {
  return {
    id: "default",
    openCodeUrl: config.openCodeUrl,
    directory: config.directory,
    enabled: true,
  }
}

function configuredSources(config: BridgeConfig): SourceConfig[] {
  if (!config.multiSourceEnabled) {
    return [defaultSource(config)]
  }
  const raw = Array.isArray(config.sources) ? config.sources : []
  const base = defaultSource(config)
  const out: SourceConfig[] = []
  const ids = new Set<string>()
  for (const source of raw) {
    const id = source?.id?.trim()
    if (!id || ids.has(id)) continue
    const openCodeUrl = source?.openCodeUrl?.trim()
    if (!openCodeUrl) continue
    if (source.enabled === false) continue
    out.push({
      id,
      openCodeUrl,
      directory: source.directory,
      enabled: true,
    })
    ids.add(id)
  }
  if (!out.length) return [base]
  return [base, ...out]
}

function encodeSessionRef(ref: SessionRef): string {
  if (ref.sourceId === "default") return ref.sessionId
  return `${ref.sourceId}::${ref.sessionId}`
}

function decodeSessionRef(value: string): SessionRef | undefined {
  const trimmed = value.trim()
  if (!trimmed) return
  const parts = trimmed.split("::")
  if (parts.length === 1) {
    return { sourceId: "default", sessionId: trimmed }
  }
  const sourceId = parts[0]?.trim()
  const sessionId = parts.slice(1).join("::").trim()
  if (!sourceId || !sessionId) return
  return { sourceId, sessionId }
}

function sourceScopedId(sourceId: string, sessionId: string): string {
  if (sourceId === "default") return sessionId
  return `${sourceId}::${sessionId}`
}

function sourceLabel(sourceId: string): string {
  if (sourceId === "default") return "default"
  return sourceId
}

function sourceUnavailableText(sourceId: string): string {
  return `Source ${sourceLabel(sourceId)} is no longer configured. Use /new to create a fresh session mapping.`
}

function sourceConfig(runtime: Runtime, sourceId: string): BridgeConfig | undefined {
  if (sourceId === "default") {
    return {
      ...runtime.config,
      openCodeUrl: runtime.config.openCodeUrl,
      directory: runtime.config.directory,
    }
  }
  const source = runtime.sourceById?.get(sourceId)
  if (!source) return
  return {
    ...runtime.config,
    openCodeUrl: source.openCodeUrl,
    directory: source.directory,
  }
}

function sourceForSessionRef(runtime: Runtime, ref: SessionRef): BridgeConfig | undefined {
  return sourceConfig(runtime, ref.sourceId)
}

const sessions = new Map<string, CachedSession>()
const creatingSessions = new Map<string, Promise<string>>()
const chatQueues = new Map<string, Promise<void>>()
const eventNotifications = new Map<string, number>()
const statusBySession = new Map<string, string>()
const fallbackNotifications = new Map<string, boolean>()
const fallbackPending = new Map<string, TelegramPendingItem[]>()
const pendingQuestions = new Map<string, TelegramPendingQuestion[]>()
const sessionHistory = new Map<string, string[]>()
const sessionInfo = new Map<string, CachedSessionInfo>()
const switchTargets = new Map<string, { sessionRef: string; expiresAt: number }>()

let pendingEntrySeq = 0

const pendingQuestionTtlMs = 30 * 60 * 1000
const startedAt = Date.now()
const pendingRetentionMs = 3 * 24 * 60 * 60 * 1000
const pendingMaxItems = 60
const pendingDigestMax = 8
const pendingTextMax = 240
const sessionHistoryMax = 60
const sessionTitleLookupBatchSize = 6
const switchPageSize = 10
const recentDefaultCount = 5
const recentMaxCount = 12
const recentPartTextMax = 500
const sessionTitleInlineMax = 120
const callbackIdLength = 24
const callbackAckText = "Sending answer..."
const promptCallbackAckText = "Running prompt..."
const notifyCallbackAckText = "Updating notifications..."
const inlineButtonMaxOptions = 20
const inlineButtonTextMax = 48
const callbackDataMax = 64
const telegramMessageSoftLimit = 3900
const recentPayloadMax = telegramMessageSoftLimit * 3
const switchTargetTtlMs = 30 * 60 * 1000

const telegramCommands = Object.freeze([
  Object.freeze({
    name: "new",
    text: "Start a fresh OpenCode session",
  }),
  Object.freeze({
    name: "status",
    text: "Show current session mapping",
  }),
  Object.freeze({
    name: "sessions",
    text: "List known sessions for this chat/user mapping",
  }),
  Object.freeze({
    name: "recent",
    text: "Show latest user/assistant exchanges",
    args: "[count]",
  }),
  Object.freeze({
    name: "switch",
    text: "Switch this chat/user mapping to an existing session",
    args: "[session-id|index]",
  }),
  Object.freeze({
    name: "notify",
    text: "Control proactive notifications",
    args: "on|off|status",
  }),
  Object.freeze({
    name: "pending",
    text: "Show pending inbox items",
  }),
  Object.freeze({
    name: "inbox",
    text: "Alias for /pending",
  }),
  Object.freeze({
    name: "prompts",
    text: "List saved prompts available in this session",
  }),
  Object.freeze({
    name: "prompt",
    text: "Run a saved prompt by name or id",
    args: "<name|id>",
  }),
  Object.freeze({
    name: "help",
    text: "Show available commands",
  }),
]) as readonly Readonly<TelegramCommand>[]

function commandName(command: TelegramCommand): string {
  return `/${command.name}`
}

function commandNames(): string[] {
  return telegramCommands.map(commandName)
}

function commandEntry(name: string): TelegramCommand | undefined {
  const trimmed = name.startsWith("/") ? name.slice(1) : name
  return telegramCommands.find((command) => command.name === trimmed)
}

function commonPrefixLength(a: string, b: string): number {
  const stop = a.split("").findIndex((ch, idx) => ch !== b[idx])
  if (stop === -1) return Math.min(a.length, b.length)
  return stop
}

function commandSuggestions(name: string): string[] {
  const input = name.startsWith("/") ? name.slice(1).toLowerCase() : name.toLowerCase()
  if (!input) return []
  const ranked = telegramCommands
    .map((command) => {
      const prefix = commonPrefixLength(command.name, input)
      const overlap = command.name.includes(input) || input.includes(command.name) ? 2 : 0
      return {
        command,
        score: prefix + overlap,
      }
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
    .map((item) => commandName(item.command))
  return [...new Set(ranked)]
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

let retryDelay = sleep

export function parseMode(value: string): "polling" | "webhook" {
  const mode = value.trim().toLowerCase()
  if (mode === "polling") return "polling"
  if (mode === "webhook") return "webhook"
  throw new Error(`Invalid TELEGRAM_MODE: ${value}. Expected \"polling\" or \"webhook\"`)
}

export function queueChatUpdate<T>(chatId: string, fn: () => Promise<T>): Promise<T> {
  const start = chatQueues.get(chatId) || Promise.resolve()
  const next = start.catch(() => undefined).then(fn)
  const tail = next.then(
    () => undefined,
    () => undefined,
  )
  chatQueues.set(chatId, tail)
  void tail.finally(() => {
    if (chatQueues.get(chatId) !== tail) return
    chatQueues.delete(chatId)
  })
  return next
}

function parseCommand(text: string): { name: string; args: string[] } | undefined {
  if (!text.startsWith("/")) return
  const parts = text
    .trim()
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
  const raw = parts[0]
  const name = raw?.split("@")[0]?.trim().toLowerCase()
  if (!name) return
  return { name, args: parts.slice(1) }
}

function helpText(): string {
  const lines = telegramCommands.map((command) => {
    const detail = command.args ? `${command.text} (${command.args})` : command.text
    return `${commandName(command)} - ${detail}`
  })
  return [
    "Available commands:",
    ...lines,
  ].join("\n")
}

function parseTelegramKey(key: string): { chatId: number; userId?: number } | undefined {
  const parts = key.split(":")
  if (parts.length < 2) return
  if (parts[0] !== "chat") return
  const chatId = Number.parseInt(parts[1] || "", 10)
  if (!Number.isFinite(chatId)) return
  if (parts.length === 2) return { chatId }
  if (parts.length !== 4) return
  if (parts[2] !== "user") return
  const userId = Number.parseInt(parts[3] || "", 10)
  if (!Number.isFinite(userId)) return
  return { chatId, userId }
}

async function notificationEnabled(runtime: Runtime, key: string): Promise<boolean> {
  if (runtime.store.notificationGet) {
    return runtime.store.notificationGet(key)
  }
  return fallbackNotifications.get(key) === true
}

async function setNotificationEnabled(runtime: Runtime, key: string, enabled: boolean): Promise<void> {
  if (runtime.store.notificationSet) {
    await runtime.store.notificationSet(key, enabled)
    return
  }
  if (enabled) {
    fallbackNotifications.set(key, true)
    return
  }
  fallbackNotifications.delete(key)
}

function prunePending(items: TelegramPendingItem[], now: number): TelegramPendingItem[] {
  const minStamp = now - pendingRetentionMs
  const kept = items
    .filter((item) => item.stampedAt >= minStamp)
    .sort((a, b) => {
      const byTime = b.stampedAt - a.stampedAt
      if (byTime !== 0) return byTime
      return a.id.localeCompare(b.id)
    })
    .slice(0, pendingMaxItems)
  return kept
}

function pendingAdapter(runtime: Runtime) {
  if (runtime.store.inboxGet && runtime.store.inboxSet) {
    return {
      get: runtime.store.inboxGet,
      set: runtime.store.inboxSet,
    }
  }
  if (runtime.store.pendingGet && runtime.store.pendingSet) {
    return {
      get: runtime.store.pendingGet,
      set: runtime.store.pendingSet,
    }
  }
  return
}

function pendingFallbackEnabled(runtime: Runtime): boolean {
  return !pendingAdapter(runtime)
}

async function pendingGet(runtime: Runtime, key: string): Promise<TelegramPendingItem[]> {
  const now = Date.now()
  const adapter = pendingAdapter(runtime)
  const source = adapter
    ? await adapter.get(key)
    : pendingFallbackEnabled(runtime)
      ? fallbackPending.get(key) || []
      : []
  const next = prunePending(source, now)
  if (adapter) {
    const changed = next.length !== source.length || next.some((item, i) => item.id !== source[i]?.id)
    if (changed) {
      await adapter.set(key, next)
    }
    return next
  }
  if (!next.length) {
    fallbackPending.delete(key)
    return next
  }
  fallbackPending.set(key, next)
  return next
}

async function pendingSet(runtime: Runtime, key: string, items: TelegramPendingItem[]): Promise<void> {
  const next = prunePending(items, Date.now())
  const adapter = pendingAdapter(runtime)
  if (adapter) {
    await adapter.set(key, next)
    return
  }
  if (!pendingFallbackEnabled(runtime)) return
  if (!next.length) {
    fallbackPending.delete(key)
    return
  }
  fallbackPending.set(key, next)
}

function pendingChatKey(chatId: number): string {
  return telegramSessionKey(chatId)
}

function pendingHint(item: TelegramPendingItem): string {
  if (item.kind === "question") return "reply with the needed answer, or use /status"
  if (item.kind === "permission") return "review in chat and reply to approve or deny"
  return "use /recent for details"
}

function pendingMessage(items: TelegramPendingItem[]): string {
  const actionable = items.filter((item) => !item.resolved && item.kind !== "task-finished")
  const finished = items.filter((item) => item.kind === "task-finished").slice(0, 3)
  if (!actionable.length && !finished.length) {
    return "Pending inbox is clear for this chat. Use /status for your current session or /new to start one."
  }
  const combined = [...actionable, ...finished].slice(0, pendingDigestMax)
  const lines = combined.map((item, index) => {
    const mins = Math.max(1, Math.round((Date.now() - item.stampedAt) / 60_000))
    const label = item.kind === "task-finished" ? "finished" : item.kind
    const sourceText = item.sourceId && item.sourceId !== "default" ? ` source ${item.sourceId},` : ""
    return `${index + 1}. [${label}] ${item.text} (${mins}m ago,${sourceText} session ${item.sessionId})`
  })
  const first = combined[0]
  const hint = first ? pendingHint(first) : "use /status"
  const more = actionable.length + finished.length - combined.length
  const extra = more > 0 ? `\n+${more} more item(s) retained.` : ""
  return `Pending inbox for this chat:\n${lines.join("\n")}\n\nNext: ${hint}.${extra}`
}

async function appendPending(runtime: Runtime, chatId: number, entry: TelegramPendingItem) {
  await queueChatUpdate(`pending:${chatId}`, async () => {
    const key = pendingChatKey(chatId)
    const items = await pendingGet(runtime, key)
    const next = [entry, ...items.filter((item) => item.id !== entry.id)]
    await pendingSet(runtime, key, next)
  })
}

function pendingEntryId(sessionId: string, kind: string, chatId: number, requestId?: string, sourceId = "default"): string {
  const base = requestId?.trim()
  if (base) return `${sourceId}:${sessionId}:${kind}:${base}:${chatId}`
  const seq = String(pendingEntrySeq).padStart(8, "0")
  pendingEntrySeq += 1
  return `${sourceId}:${sessionId}:${kind}:${Date.now()}:${seq}:${chatId}`
}

function pendingQuestionText(question: TelegramPendingQuestion): string {
  const row = question.questions[0]
  const title = row?.header || row?.question || "The assistant is waiting for your answer."
  const text = `Question pending: ${title}`
  if (text.length <= pendingTextMax) return text
  if (pendingTextMax <= 3) return text.slice(0, pendingTextMax)
  return `${text.slice(0, pendingTextMax - 3)}...`
}

async function resolvePendingForSession(runtime: Runtime, chatId: number, sessionId: string, sourceId = "default") {
  await queueChatUpdate(`pending:${chatId}`, async () => {
    const key = pendingChatKey(chatId)
    const items = await pendingGet(runtime, key)
    const next = items.map((item) => {
      const itemSourceId = item.sourceId || "default"
      if (item.sessionId !== sessionId || itemSourceId !== sourceId) return item
      if (item.resolved) return item
      if (item.kind === "task-finished") return item
      return { ...item, resolved: true }
    })
    await pendingSet(runtime, key, next)
  })
}

function sessionLabel(config: BridgeConfig, sessionId: string, sourceId = "default"): string {
  const prefixed = sourceId === "default" ? `session ${sessionId}` : `[${sourceLabel(sourceId)}] session ${sessionId}`
  if (!config.sessionLinkBase) return prefixed
  return `${config.sessionLinkBase}/session/${encodeURIComponent(sessionId)}`
}

function notificationKey(chatId: number): string {
  return telegramSessionKey(chatId)
}

async function notificationTargets(runtime: Runtime): Promise<string[]> {
  if (!runtime.store.notificationKeys) return []
  const keys = await runtime.store.notificationKeys()
  const targets = new Set<string>()
  for (const key of keys) {
    const parsed = parseTelegramKey(key)
    if (!parsed) continue
    const chatKey = notificationKey(parsed.chatId)
    if (runtime.store.notificationGet && !(await notificationEnabled(runtime, chatKey))) continue
    targets.add(chatKey)
  }
  return [...targets]
}

async function sessionTargets(runtime: Runtime, ref: SessionRef): Promise<string[]> {
  if (!runtime.store.sessionKeys) return []
  const keys = await runtime.store.sessionKeys(encodeSessionRef(ref))
  const targets = new Set<string>()
  for (const key of keys) {
    const parsed = parseTelegramKey(key)
    if (!parsed) continue
    targets.add(key)
  }
  return [...targets]
}

async function pendingTargets(runtime: Runtime, ref: SessionRef): Promise<string[]> {
  const scoped = sourceScopedId(ref.sourceId, ref.sessionId)
  const alarmEnabled = runtime.store.sessionAlarmGet
    ? await runtime.store.sessionAlarmGet(scoped)
    : true
  if (!alarmEnabled) return []

  const targets = new Set<string>()
  const mapped = await sessionTargets(runtime, ref)
  for (const key of mapped) {
    targets.add(key)
  }
  const optedIn = await notificationTargets(runtime)
  for (const key of optedIn) {
    targets.add(key)
  }
  return [...targets]
}

async function eventTargets(runtime: Runtime, ref: SessionRef): Promise<string[]> {
  const scoped = sourceScopedId(ref.sourceId, ref.sessionId)
  const alarmEnabled = runtime.store.sessionAlarmGet
    ? await runtime.store.sessionAlarmGet(scoped)
    : true
  if (!alarmEnabled) return []

  const optedIn = await notificationTargets(runtime)
  if (optedIn.length) return optedIn
  const keys = await sessionTargets(runtime, ref)
  if (!keys.length) return []

  const targets = new Set<string>()
  for (const key of keys) {
    const parsed = parseTelegramKey(key)
    if (!parsed) continue
    if (!(await notificationEnabled(runtime, notificationKey(parsed.chatId)))) continue
    targets.add(key)
  }
  return [...targets]
}

function proactiveTelegramEnabled(config: BridgeConfig): boolean {
  return config.telegramAlarmChannelEnabled !== false
}

function shouldNotify(config: BridgeConfig, chatId: number, kind: string, sessionId: string, sourceId = "default"): boolean {
  const now = Date.now()
  const cutoff = now - Math.max(config.notificationDebounceMs * 3, 60_000)
  for (const [entryKey, stampedAt] of eventNotifications) {
    if (stampedAt >= cutoff) continue
    eventNotifications.delete(entryKey)
  }
  const key = `${chatId}:${kind}:${sourceId}:${sessionId}`
  const previous = eventNotifications.get(key)
  if (previous && now - previous < config.notificationDebounceMs) return false
  return true
}

function stampNotification(chatId: number, kind: string, sessionId: string, sourceId = "default") {
  eventNotifications.set(`${chatId}:${kind}:${sourceId}:${sessionId}`, Date.now())
}

function questionText(properties: Record<string, unknown>): string {
  const questions = Array.isArray(properties.questions) ? properties.questions : []
  const first = questions[0] as { header?: unknown; question?: unknown } | undefined
  const header = typeof first?.header === "string" ? first.header.trim() : ""
  if (header) return header
  const question = typeof first?.question === "string" ? first.question.trim() : ""
  if (question) return question.slice(0, 120)
  return "The assistant is waiting for your answer."
}

function pendingKey(chatId: number, userId?: number): string {
  return telegramSessionKey(chatId, userId)
}

function pendingLookupKeys(chatId: number, userId?: number): string[] {
  const first = pendingKey(chatId, userId)
  const second = pendingKey(chatId)
  if (first === second) return [first]
  return [first, second]
}

function trimQuestionList(list: TelegramPendingQuestion[]): TelegramPendingQuestion[] {
  const now = Date.now()
  return list
    .filter((item) => item.expiresAt > now)
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(-10)
}

async function readPendingQuestionsByKey(runtime: Runtime, key: string): Promise<TelegramPendingQuestion[]> {
  const stored = runtime.store.questionList
    ? await runtime.store.questionList(key)
    : pendingQuestions.get(key) || []
  const next = trimQuestionList(stored)
  if (next.length === stored.length) return next
  if (runtime.store.questionUpsert && runtime.store.questionDelete) {
    for (const item of stored) {
      if (next.find((nextItem) => nextItem.requestId === item.requestId)) continue
      await runtime.store.questionDelete(key, item.requestId)
    }
    return next
  }
  if (next.length) {
    pendingQuestions.set(key, next)
    return next
  }
  pendingQuestions.delete(key)
  return []
}

async function readPendingQuestionMatch(
  runtime: Runtime,
  chatId: number,
  userId?: number,
): Promise<{ itemKey: string; pending: TelegramPendingQuestion } | undefined> {
  for (const itemKey of pendingLookupKeys(chatId, userId)) {
    const queue = await readPendingQuestionsByKey(runtime, itemKey)
    const pending = queue[0]
    if (!pending) continue
    return { itemKey, pending }
  }
}

async function upsertPendingQuestion(runtime: Runtime, key: string, question: TelegramPendingQuestion) {
  if (runtime.store.questionUpsert) {
    await runtime.store.questionUpsert(key, question)
    return
  }
  const current = pendingQuestions.get(key) || []
  const next = [...current.filter((item) => item.requestId !== question.requestId), question]
  const clean = trimQuestionList(next)
  if (clean.length) {
    pendingQuestions.set(key, clean)
    return
  }
  pendingQuestions.delete(key)
}

async function deletePendingQuestionByKey(runtime: Runtime, key: string, requestId: string) {
  if (runtime.store.questionDelete) {
    await runtime.store.questionDelete(key, requestId)
    return
  }
  const current = pendingQuestions.get(key) || []
  const next = current.filter((item) => item.requestId !== requestId)
  if (next.length) {
    pendingQuestions.set(key, next)
    return
  }
  pendingQuestions.delete(key)
}

function shortId(input: string): string {
  let hash = 2166136261
  for (const ch of input) {
    hash ^= ch.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36).slice(0, 8)
}

function callbackQuestionId(requestId: string): string {
  const clean = requestId.toLowerCase().replace(/[^a-z0-9]/g, "")
  if (clean.length >= 12) return clean.slice(0, callbackIdLength)
  const mixed = `${clean}${shortId(requestId)}`
  return mixed.padStart(12, "0").slice(0, callbackIdLength)
}

function callbackData(question: TelegramPendingQuestion, questionIndex: number, optionIndex: number): string {
  const row = questionIndex + 1
  const option = optionIndex + 1
  return `q:${question.callbackId}:${row}:${option}`
}

function promptCallbackData(promptId: string): string | undefined {
  const clean = promptId.trim()
  if (!clean) return
  if (!/^[A-Za-z0-9._:-]+$/.test(clean)) return
  const payload = `p:${clean}`
  if (payload.length > callbackDataMax) return
  return payload
}

function notifyCallbackData(mode: "on" | "off" | "status"): string {
  return `n:${mode}`
}

function answeredQuestions(question: TelegramPendingQuestion): number {
  if (!question.answers.length) return 0
  return Math.min(question.questions.length, question.answers.length)
}

function pendingQuestionIndex(question: TelegramPendingQuestion): number {
  const answered = answeredQuestions(question)
  if (answered >= question.questions.length) return question.questions.length - 1
  return answered
}

function activeQuestion(question: TelegramPendingQuestion): TelegramPendingQuestion["questions"][number] | undefined {
  const index = pendingQuestionIndex(question)
  return question.questions[index]
}

function parseCallbackData(input: string):
  | { kind: "question"; callbackId: string; questionIndex: number; optionIndex: number }
  | { kind: "prompt"; promptId: string }
  | { kind: "notify"; mode: "on" | "off" | "status" }
  | undefined {
  const question = input.match(/^q:([a-z0-9]{6,24}):(\d+):(\d+)$/)
  if (question) {
    const questionIndex = Number.parseInt(question[2] || "", 10)
    const optionIndex = Number.parseInt(question[3] || "", 10)
    if (!Number.isFinite(questionIndex) || !Number.isFinite(optionIndex)) return
    if (questionIndex < 1 || optionIndex < 1) return
    return {
      kind: "question",
      callbackId: question[1] || "",
      questionIndex: questionIndex - 1,
      optionIndex: optionIndex - 1,
    }
  }

  if (input.startsWith("p:")) {
    const promptId = input.slice(2)
    if (!promptId) return
    if (promptId.length > callbackDataMax - 2) return
    if (!/^[A-Za-z0-9._:-]+$/.test(promptId)) return
    return {
      kind: "prompt",
      promptId,
    }
  }

  const notify = input.match(/^n:(on|off|status)$/)
  if (!notify) return
  return {
    kind: "notify",
    mode: (notify[1] as "on" | "off" | "status") || "status",
  }
}

function notifyText(enabled: boolean, mode: "on" | "off" | "status"): string {
  if (mode === "on") return "Notifications enabled for this chat."
  if (mode === "off") return "Notifications disabled for this chat."
  return enabled ? "Notifications are enabled." : "Notifications are disabled."
}

function notifyMarkup(enabled: boolean): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
  const on = enabled ? "On ✅" : "On"
  const off = enabled ? "Off" : "Off ✅"
  return {
    inline_keyboard: [
      [
        { text: on, callback_data: notifyCallbackData("on") },
        { text: off, callback_data: notifyCallbackData("off") },
      ],
      [{ text: "Status", callback_data: notifyCallbackData("status") }],
    ],
  }
}

type SwitchCallbackData =
  | { action: "page"; page: number }
  | { action: "select"; index: number; token: string }

type UtilityCallbackData =
  | { action: "recent" }
  | { action: "switch"; token: string }

function switchToken(sessionId: string): string {
  return shortId(sessionId).slice(0, 8).padStart(6, "0")
}

function switchPageCallback(page: number): string {
  return `s:p:${page + 1}`
}

function switchSelectCallback(index: number, sessionId: string): string {
  return `s:s:${index + 1}:${switchToken(sessionId)}`
}

function parseSwitchCallbackData(input: string): SwitchCallbackData | undefined {
  const page = input.match(/^s:p:(\d+)$/)
  if (page) {
    const raw = Number.parseInt(page[1] || "", 10)
    if (!Number.isFinite(raw) || raw < 1) return
    return { action: "page", page: raw - 1 }
  }
  const selected = input.match(/^s:s:(\d+):([a-z0-9]{6,24})$/)
  if (!selected) return
  const index = Number.parseInt(selected[1] || "", 10)
  if (!Number.isFinite(index) || index < 1) return
  return { action: "select", index: index - 1, token: selected[2] || "" }
}

function pruneSwitchTargets(now: number) {
  for (const [token, value] of switchTargets) {
    if (value.expiresAt > now) continue
    switchTargets.delete(token)
  }
}

function utilitySwitchSessionCallbackData(sourceId: string, sessionId: string): string {
  const now = Date.now()
  pruneSwitchTargets(now)
  const sessionRef = encodeSessionRef({ sourceId, sessionId })
  const tokenSeed = `${sessionRef}:${now}:${pendingEntrySeq++}`
  const token = `${shortId(tokenSeed)}${Math.abs(pendingEntrySeq).toString(36)}`.slice(0, 12)
  switchTargets.set(token, { sessionRef, expiresAt: now + switchTargetTtlMs })
  return `u:s:${token}`
}

function resolveUtilitySwitchTarget(token: string): string | undefined {
  const now = Date.now()
  pruneSwitchTargets(now)
  const stored = switchTargets.get(token)
  if (!stored) return
  if (stored.expiresAt <= now) {
    switchTargets.delete(token)
    return
  }
  return stored.sessionRef
}

function utilityRecentCallbackData(): string {
  return "u:recent"
}

function parseUtilityCallbackData(input: string): UtilityCallbackData | undefined {
  if (input === "u:recent") return { action: "recent" }
  const switchSession = input.match(/^u:s:([a-z0-9]{6,24})$/)
  if (switchSession) {
    return { action: "switch", token: switchSession[1] || "" }
  }
}

function proactiveActionsMarkup(kind: "default" | "task-finished", sourceId: string, sessionId: string): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
  const switchCallback = kind === "task-finished"
    ? utilitySwitchSessionCallbackData(sourceId, sessionId)
    : switchPageCallback(0)
  return {
    inline_keyboard: [[
      { text: "Switch session", callback_data: switchCallback },
      { text: "Latest message", callback_data: utilityRecentCallbackData() },
    ]],
  }
}

function questionMarkup(question: TelegramPendingQuestion): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } | undefined {
  if (!question.callbackId) return
  const index = pendingQuestionIndex(question)
  const row = question.questions[index]
  if (!row) return
  if (row.multiple) return
  if (!row.options.length) return
  if (row.options.length > inlineButtonMaxOptions) return
  const inline = row.options.map((option, optionIndex) => {
    const callback = callbackData(question, index, optionIndex)
    const safe = option.trim().slice(0, inlineButtonTextMax)
    if (!safe) return
    if (callback.length > callbackDataMax) return
    return [{ text: safe, callback_data: callback }]
  }).filter((item) => item !== undefined)
  if (inline.length !== row.options.length) return
  return {
    inline_keyboard: inline as Array<Array<{ text: string; callback_data: string }>>,
  }
}

function parsePendingQuestion(properties: Record<string, unknown>, sourceId = "default"): TelegramPendingQuestion | undefined {
  const requestId = typeof properties.id === "string" ? properties.id.trim() : ""
  const sessionId = typeof properties.sessionID === "string" ? properties.sessionID.trim() : ""
  const rows = Array.isArray(properties.questions) ? properties.questions : []
  const questions = rows
    .map((row) => {
      if (!row || typeof row !== "object") return
      const value = row as Record<string, unknown>
      const header = typeof value.header === "string" ? value.header.trim() : ""
      const question = typeof value.question === "string" ? value.question.trim() : ""
      const options = Array.isArray(value.options)
        ? value.options
          .map((item) => {
            if (!item || typeof item !== "object") return ""
            const option = item as { label?: unknown }
            return typeof option.label === "string" ? option.label.trim() : ""
          })
          .filter(Boolean)
        : []
      const multiple = value.multiple === true
      const custom = value.custom !== false
      if (!header && !question && !options.length) return
      return {
        header,
        question,
        options,
        multiple,
        custom,
      }
    })
    .filter((item) => item !== undefined)
  const parsed = questions as TelegramPendingQuestion["questions"]
  if (!requestId || !sessionId || !parsed.length) return
  const now = Date.now()
  return {
    requestId,
    callbackId: callbackQuestionId(requestId),
    sessionId,
    sourceId,
    createdAt: now,
    expiresAt: now + pendingQuestionTtlMs,
    questions: parsed,
    answers: [],
  }
}

function permissionText(properties: Record<string, unknown>): string {
  const permission = typeof properties.permission === "string" ? properties.permission : "permission"
  const patterns = Array.isArray(properties.patterns)
    ? properties.patterns.filter((part) => typeof part === "string" && part).slice(0, 3)
    : []
  if (!patterns.length) return `Permission request: ${permission}`
  return `Permission request: ${permission} (${patterns.join(", ")})`
}

function questionPromptText(question: TelegramPendingQuestion): string {
  const lines = ["Question pending:"]
  for (let i = 0; i < question.questions.length; i++) {
    const row = question.questions[i]
    if (!row) continue
    const title = row.header || row.question || `Question ${i + 1}`
    if (question.questions.length > 1) {
      lines.push("")
      lines.push(`${i + 1}. ${title}`)
    }
    if (question.questions.length === 1) {
      lines.push(title)
    }
    const detail = row.question && row.question !== row.header ? row.question : ""
    if (detail) lines.push(detail)
    for (let index = 0; index < row.options.length; index++) {
      lines.push(`${index + 1}) ${row.options[index]}`)
    }
    if (!row.options.length && row.custom) {
      lines.push("Reply with your answer as text.")
    }
    if (row.options.length && row.multiple) {
      lines.push("You can pick multiple options: reply like 1,3")
    }
    if (row.options.length && !row.multiple) {
      lines.push("Reply with an option number or label.")
    }
    if (row.options.length && row.custom) {
      lines.push("You can also reply with custom text.")
    }
  }
  if (question.questions.length > 1) {
    lines.push("")
    const answered = answeredQuestions(question)
    lines.push(`Progress: ${answered}/${question.questions.length} answered.`)
  }
  lines.push("")
  lines.push("Use /status to see your current session.")
  return lines.join("\n")
}

function questionStepText(question: TelegramPendingQuestion, hasButtons = false): string {
  const index = pendingQuestionIndex(question)
  const row = question.questions[index]
  if (!row) return questionPromptText(question)
  const title = row.header || row.question || `Question ${index + 1}`
  const lines = ["Question pending:"]
  if (question.questions.length > 1) {
    lines.push(`Step ${index + 1}/${question.questions.length}`)
  }
  lines.push(title)
  const detail = row.question && row.question !== row.header ? row.question : ""
  if (detail) lines.push(detail)
  for (let optionIndex = 0; optionIndex < row.options.length; optionIndex++) {
    lines.push(`${optionIndex + 1}) ${row.options[optionIndex]}`)
  }
  if (!row.options.length && row.custom) {
    lines.push("Reply with your answer as text.")
  }
  if (row.options.length && row.multiple) {
    lines.push("You can pick multiple options: reply like 1,3")
  }
  if (row.options.length && !row.multiple) {
    lines.push(hasButtons ? "Choose using the buttons below, or reply with an option number or label." : "Reply with an option number or label.")
  }
  if (row.options.length && row.custom) {
    lines.push("You can also reply with custom text.")
  }
  lines.push("")
  lines.push("Use /status to see your current session.")
  return lines.join("\n")
}

function truncateTelegramText(input: string, size: number): string {
  if (input.length <= size) return input
  const suffix = "\n\n..."
  if (size <= suffix.length) return input.slice(0, size)
  return `${input.slice(0, size - suffix.length)}${suffix}`
}

function truncateTelegramInlineText(input: string, size: number): string {
  if (input.length <= size) return input
  const suffix = "..."
  if (size <= suffix.length) return input.slice(0, size)
  return `${input.slice(0, size - suffix.length)}${suffix}`
}

function questionAnswerGuidance(question: TelegramPendingQuestion): string {
  const row = activeQuestion(question)
  if (!row) return "No pending question was found."
  if (row.options.length) {
    if (row.multiple) {
      return `Please reply with one or more option numbers between 1 and ${row.options.length} (for example: 1,3), or send /help for commands.`
    }
    return `Please reply with an option number between 1 and ${row.options.length}, or send /help for commands.`
  }
  return "Please reply with text for the pending question, or send /help for commands."
}

function parseNumericChoices(input: string): number[] | undefined {
  const parts = input
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter(Boolean)
  if (!parts.length) return
  const values = parts.map((part) => {
    if (!/^\d+$/.test(part)) return Number.NaN
    const value = Number.parseInt(part, 10)
    if (value < 1) return Number.NaN
    return value
  })
  if (values.some((value) => !Number.isFinite(value))) return
  return [...new Set(values)]
}

function matchLabel(options: string[], input: string): string | undefined {
  const exact = options.find((option) => option === input)
  if (exact) return exact
  const lowered = input.toLowerCase()
  return options.find((option) => option.toLowerCase() === lowered)
}

function answerFromInput(row: TelegramPendingQuestion["questions"][number], input: string): string[] | undefined {
  const text = input.trim()
  if (!text) return
  const numbers = parseNumericChoices(text)
  if (numbers && row.options.length) {
    if (!row.multiple && numbers.length > 1) return
    const labels = numbers
      .map((value) => row.options[value - 1])
      .filter((value) => typeof value === "string" && value)
    if (!labels.length || labels.length !== numbers.length) return
    return labels
  }
  const matched = row.options.length ? matchLabel(row.options, text) : undefined
  if (matched) return [matched]
  if (row.custom) return [text]
  return
}

function parseQuestionAnswers(question: TelegramPendingQuestion, text: string): string[][] | undefined {
  if (question.questions.length === 1) {
    const row = question.questions[0]
    if (!row) return
    const answer = answerFromInput(row, text)
    if (!answer) return
    return [answer]
  }

  const map = new Map<number, string>()
  const chunks = text
    .split(/[\n;]+/)
    .map((part) => part.trim())
    .filter(Boolean)
  for (const chunk of chunks) {
    const match = chunk.match(/^(\d+)\s*:\s*(.+)$/)
    if (!match) continue
    const index = Number.parseInt(match[1] || "", 10)
    const value = match[2]?.trim() || ""
    if (!Number.isFinite(index) || !value) continue
    map.set(index, value)
  }

  if (map.size < question.questions.length) return
  const answers: string[][] = []
  for (let i = 0; i < question.questions.length; i++) {
    const row = question.questions[i]
    if (!row) return
    const value = map.get(i + 1)
    if (!value) return
    const parsed = answerFromInput(row, value)
    if (!parsed) return
    answers.push(parsed)
  }
  return answers
}

function nextAnswers(question: TelegramPendingQuestion, answer: string[]): string[][] | undefined {
  const answered = answeredQuestions(question)
  const row = question.questions[answered]
  if (!row) return
  const existing = question.answers.slice(0, answered)
  return [...existing, answer]
}

function withAnswers(question: TelegramPendingQuestion, answers: string[][]): TelegramPendingQuestion {
  return {
    ...question,
    answers: answers.slice(0, question.questions.length),
  }
}

function parseEvent(rawData: string): { type: string; properties: Record<string, unknown> } | undefined {
  const decoded = JSON.parse(rawData) as { payload?: unknown; type?: unknown; properties?: unknown }
  const event = decoded.payload && typeof decoded.payload === "object"
    ? decoded.payload as { type?: unknown; properties?: unknown }
    : decoded
  if (typeof event.type !== "string") return
  const properties = event.properties && typeof event.properties === "object"
    ? event.properties as Record<string, unknown>
    : {}
  return {
    type: event.type,
    properties,
  }
}

export function createOutboundSSEParser() {
  let buffer = ""
  let pendingCR = false

  const blocks = () => {
    const parts: string[] = []
    while (true) {
      const boundary = buffer.indexOf("\n\n")
      if (boundary === -1) return parts
      parts.push(buffer.slice(0, boundary))
      buffer = buffer.slice(boundary + 2)
    }
  }

  return {
    push(chunk: string) {
      let normalized = ""
      for (const ch of chunk) {
        if (ch === "\r") {
          if (pendingCR) {
            normalized += "\n"
          }
          pendingCR = true
          continue
        }
        if (ch === "\n") {
          normalized += "\n"
          pendingCR = false
          continue
        }
        if (pendingCR) {
          normalized += "\n"
          pendingCR = false
        }
        normalized += ch
      }
      buffer += normalized
      return blocks()
    },
    flush() {
      if (pendingCR) {
        buffer += "\n"
        pendingCR = false
      }
      return blocks()
    },
  }
}

export function parseConfig(): BridgeConfig {
  const settings = loadTelegramBridgeSettings()
  if (!settings.token) {
    throw new Error("Telegram token is required. Set TELEGRAM_BOT_TOKEN or save token in persisted Telegram settings.")
  }
  return settings
}

function isMissingSession(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.message.startsWith("OpenCode prompt failed (404):")) return true
  if (error.message.startsWith("OpenCode prompt failed (410):")) return true
  return false
}

export function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === "TimeoutError") return true
  if ("code" in error && error.code === "ETIMEDOUT") return true
  const message = error.message.toLowerCase()
  if (message.includes("timed out")) return true
  if (message.includes("timeout")) return true
  return false
}

async function retry<T>(
  name: string,
  fn: () => Promise<T>,
  retries = 2,
  delayMs = 400,
  shouldRetry: (error: unknown) => boolean = () => true,
): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    if (!shouldRetry(error)) throw error
    if (retries <= 0) throw error
    console.warn(`[TelegramBridge] ${name} failed, retrying in ${delayMs}ms`, error)
    await retryDelay(delayMs)
    return retry(name, fn, retries - 1, Math.min(delayMs * 2, 4000), shouldRetry)
  }
}

export function setRetryDelayForTest(next?: (ms: number) => Promise<void>) {
  retryDelay = next || sleep
}

async function telegramRequest(config: BridgeConfig, method: string, body: Record<string, unknown>, timeoutMs = 10_000) {
  const run = async () => {
    const url = `https://api.telegram.org/bot${config.token}/${method}`
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean
      result?: unknown
      description?: string
    }

    if (!res.ok || !data.ok) {
      const detail = data.description || `HTTP ${res.status}`
      throw new Error(`Telegram ${method} failed: ${detail}`)
    }

    return data.result
  }

  return retry(`telegram:${method}`, run)
}

export function joinOpenCodeUrl(openCodeUrl: string, path: string): URL {
  const url = new URL(openCodeUrl)
  const basePath = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`
  const nextPath = path.startsWith("/") ? path.slice(1) : path
  url.pathname = `${basePath}${nextPath}`
  return url
}

export async function registerTelegramCommands(config: BridgeConfig) {
  await telegramRequest(config, "setMyCommands", {
    commands: telegramCommands.map((command) => ({
      command: command.name,
      description: command.text,
    })),
  })
}

function registerTelegramCommandsWithoutBlocking(config: BridgeConfig) {
  void registerTelegramCommands(config)
    .then(() => {
      console.log(`[TelegramBridge] Registered bot commands: ${commandNames().join(", ")}`)
    })
    .catch((error) => {
      console.warn("[TelegramBridge] failed to register bot commands", error)
    })
}

function opencodeUrl(config: BridgeConfig, path: string): URL {
  return joinOpenCodeUrl(config.openCodeUrl, path)
}

async function createSession(config: BridgeConfig): Promise<string> {
  const url = opencodeUrl(config, "/session")
  if (config.directory) {
    url.searchParams.set("directory", config.directory)
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(12_000),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`OpenCode session create failed (${res.status}): ${body.slice(0, 300)}`)
  }

  const data = (await res.json()) as { id?: string }
  if (!data.id) {
    throw new Error("OpenCode session create returned no id")
  }

  return data.id
}

function normalizeSessionHistory(input: string[]): string[] {
  const deduped = [...new Set(input.map((value) => value.trim()).filter(Boolean))]
  return deduped.slice(0, sessionHistoryMax)
}

function touchSessionHistory(runtime: Runtime, chatKey: string, list: string[]) {
  sessionHistory.delete(chatKey)
  if (!list.length) return
  sessionHistory.set(chatKey, list)
  const max = Math.max(1, runtime.config.sessionCacheMax)
  for (const key of sessionHistory.keys()) {
    if (sessionHistory.size <= max) return
    sessionHistory.delete(key)
  }
}

function logSessionHistoryError(chatKey: string, op: "load" | "store", error: unknown) {
  console.error(`[TelegramBridge] session history ${op} failed`, { chatKey, error })
}

async function loadSessionHistory(runtime: Runtime, chatKey: string): Promise<string[]> {
  const cached = sessionHistory.get(chatKey)
  if (cached) {
    touchSessionHistory(runtime, chatKey, cached)
    return cached
  }
  if (!runtime.store.historyGet) return []
  const stored = await runtime.store.historyGet(chatKey)
    .then((list) => normalizeSessionHistory(list))
    .catch((error) => {
      logSessionHistoryError(chatKey, "load", error)
      return []
    })
  if (!stored.length) return []
  touchSessionHistory(runtime, chatKey, stored)
  return stored
}

async function setSessionHistory(runtime: Runtime, chatKey: string, input: string[]): Promise<string[]> {
  const next = normalizeSessionHistory(input)
  if (!next.length) {
    sessionHistory.delete(chatKey)
    if (!runtime.store.historySet) return []
    await runtime.store.historySet(chatKey, []).catch((error) => {
      logSessionHistoryError(chatKey, "store", error)
    })
    return []
  }
  touchSessionHistory(runtime, chatKey, next)
  if (!runtime.store.historySet) return next
  await runtime.store.historySet(chatKey, next).catch((error) => {
    logSessionHistoryError(chatKey, "store", error)
  })
  return next
}

async function switchCandidates(runtime: Runtime, chatKey: string, current?: string): Promise<string[]> {
  const history = await loadSessionHistory(runtime, chatKey)
  if (!current) return history
  return normalizeSessionHistory([current, ...history])
}

async function rememberSession(runtime: Runtime, chatKey: string, sessionId: string): Promise<string[]> {
  const prior = await loadSessionHistory(runtime, chatKey)
  if (prior[0] === sessionId) return prior
  const next = normalizeSessionHistory([sessionId, ...prior])
  return setSessionHistory(runtime, chatKey, next)
}

function rememberSessionWithoutBlocking(runtime: Runtime, chatKey: string, sessionId: string) {
  void rememberSession(runtime, chatKey, sessionId).catch((error) => {
    console.error("[TelegramBridge] session history update failed", { chatKey, sessionId, error })
  })
}

async function sessionsText(runtime: Runtime, chatKey: string, current?: string): Promise<string> {
  const history = await loadSessionHistory(runtime, chatKey)
  const list = current ? normalizeSessionHistory([current, ...history]) : history
  if (!list.length) {
    return "No known sessions for this chat/user mapping yet. Use /new to create one, then /sessions to view options."
  }
  const lines = await formatSessionList(runtime, list, current)
  return `Known sessions for this chat/user mapping:\n${lines.join("\n")}\n\nUse /switch [session-id|index] to switch. Tip: run /switch to pick from recent sessions quickly.`
}

function trimSessionTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return
  const text = value.trim()
  if (!text) return
  return text
}

function pruneExpiredSessionInfo(now: number) {
  for (const [key, value] of sessionInfo) {
    if (value.expiresAt > now) continue
    sessionInfo.delete(key)
  }
}

function cacheSessionInfo(config: BridgeConfig, sessionId: string, info: SessionLookup, sourceId = "default") {
  const now = Date.now()
  const expiresAt = now + config.sessionCacheTtlMs
  const key = sourceScopedId(sourceId, sessionId)
  sessionInfo.delete(key)
  sessionInfo.set(key, { exists: info.exists, title: info.title || null, expiresAt })
  pruneExpiredSessionInfo(now)
  for (const key of sessionInfo.keys()) {
    if (sessionInfo.size <= config.sessionCacheMax * 2) return
    sessionInfo.delete(key)
  }
}

function cachedSessionLookup(sessionId: string, sourceId = "default"): SessionLookup | undefined {
  const key = sourceScopedId(sourceId, sessionId)
  const cached = sessionInfo.get(key)
  if (!cached) return
  if (cached.expiresAt <= Date.now()) {
    sessionInfo.delete(key)
    return
  }
  return {
    exists: cached.exists,
    title: cached.title || undefined,
  }
}

function formatSessionDisplay(sessionId: string, title?: string, sourceId = "default"): string {
  const id = sessionId.trim()
  const scoped = sourceId === "default" ? id : `[${sourceLabel(sourceId)}] ${id}`
  if (!title) return scoped
  const single = title.replace(/\s+/g, " ").trim()
  if (!single) return scoped
  const safe = truncateTelegramInlineText(single, sessionTitleInlineMax)
  return `${safe} (${scoped})`
}

async function formatSessionList(runtime: Runtime, list: string[], current?: string): Promise<string[]> {
  const active = current?.trim()
  const details = await formatSessionRows(runtime, list)
  return list.map((sessionRef, index) => {
    const suffix = active === sessionRef.trim() ? " (current)" : ""
    return `${index + 1}. ${details[index]}${suffix}`
  })
}

async function formatSessionRows(runtime: Runtime, list: string[]): Promise<string[]> {
  const rows = await Promise.all(
    list
      .slice(0, sessionTitleLookupBatchSize)
      .map(async (storedRef) => {
        const ref = decodeSessionRef(storedRef)
        if (!ref) return storedRef
        const scoped = sourceForSessionRef(runtime, ref)
        if (!scoped) return formatSessionDisplay(ref.sessionId, undefined, ref.sourceId)
        const title = await safeSessionTitle(scoped, ref.sessionId, ref.sourceId)
        return formatSessionDisplay(ref.sessionId, title, ref.sourceId)
      }),
  )
  if (list.length <= sessionTitleLookupBatchSize) return rows
  const tail = await formatSessionRows(runtime, list.slice(sessionTitleLookupBatchSize))
  return [...rows, ...tail]
}

function normalizeSessionLookupId(sessionId: string): string | undefined {
  const id = sessionId.trim()
  if (!id) return
  return id
}

type SessionLookup = {
  exists: boolean
  title?: string
}

async function readSessionInfo(config: BridgeConfig, sessionId: string): Promise<SessionLookup> {
  const id = sessionId.trim()
  if (!id) return { exists: false }
  const url = opencodeUrl(config, `/session/${encodeURIComponent(id)}`)
  if (config.directory) {
    url.searchParams.set("directory", config.directory)
  }
  const res = await fetch(url, {
    method: "GET",
    signal: AbortSignal.timeout(12_000),
  })
  if (res.status === 404) return { exists: false }
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`OpenCode session lookup failed (${res.status}): ${body.slice(0, 300)}`)
  }
  const payload = await res.json().catch(() => ({})) as { title?: unknown }
  return {
    exists: true,
    title: trimSessionTitle(payload.title),
  }
}

async function sessionTitle(config: BridgeConfig, sessionId: string, sourceId = "default"): Promise<string | undefined> {
  const id = normalizeSessionLookupId(sessionId)
  if (!id) return
  const cached = cachedSessionLookup(id, sourceId)
  if (cached) {
    if (!cached.exists) return
    return cached.title
  }
  const loaded = await readSessionInfo(config, id)
  cacheSessionInfo(config, id, loaded, sourceId)
  if (!loaded.exists) return
  return loaded.title
}

async function safeSessionTitle(config: BridgeConfig, sessionId: string, sourceId = "default"): Promise<string | undefined> {
  return sessionTitle(config, sessionId, sourceId).catch(() => undefined)
}

function normalizeRecentCount(args: string[]): { count?: number; error?: string } {
  const usage = `Usage: /recent [count] (count must be >= 1; values above ${recentMaxCount} are clamped to ${recentMaxCount})`
  const raw = args[0]?.trim()
  if (!raw) return { count: recentDefaultCount }
  if (!/^\d+$/.test(raw)) {
    return { error: usage }
  }
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 1) {
    return { error: usage }
  }
  return { count: Math.min(parsed, recentMaxCount) }
}

function parseRecentText(parts: unknown): string {
  if (!Array.isArray(parts)) return ""
  const text = parts
    .map((part) => {
      if (!part || typeof part !== "object") return ""
      const row = part as { type?: unknown; text?: unknown; ignored?: unknown; synthetic?: unknown }
      if (row.type !== "text") return ""
      if (row.ignored === true) return ""
      if (row.synthetic === true) return ""
      if (typeof row.text !== "string") return ""
      return row.text
    })
    .join("\n")
    .replace(/\s+/g, " ")
    .trim()
  if (!text) return ""
  return truncateTelegramInlineText(text, recentPartTextMax)
}

async function recentText(config: BridgeConfig, sessionId: string, count: number): Promise<string> {
  const safeCount = Math.max(1, Math.min(count, recentMaxCount))
  const url = opencodeUrl(config, `/session/${encodeURIComponent(sessionId)}/message`)
  url.searchParams.set("limit", String(Math.max(20, safeCount * 6)))
  if (config.directory) {
    url.searchParams.set("directory", config.directory)
  }
  const res = await fetch(url, {
    method: "GET",
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`OpenCode session messages failed (${res.status}): ${body.slice(0, 300)}`)
  }
  const data = await res.json().catch(() => [])
  const rows = Array.isArray(data) ? data : []
  const assistants = new Map<string, string>()
  const users: Array<{ id: string; text: string; created: number }> = []
  for (const entry of rows) {
    if (!entry || typeof entry !== "object") continue
    const row = entry as { info?: unknown; parts?: unknown }
    const info = row.info && typeof row.info === "object"
      ? row.info as { id?: unknown; role?: unknown; parentID?: unknown }
      : undefined
    if (!info) continue
    const id = typeof info.id === "string" ? info.id : ""
    const parentID = typeof info.parentID === "string" ? info.parentID : ""
    const role = info.role === "assistant" || info.role === "user" ? info.role : ""
    const time = "time" in info && info.time && typeof info.time === "object"
      ? info.time as { created?: unknown }
      : undefined
    const created = typeof time?.created === "number" && Number.isFinite(time.created) ? time.created : 0
    const text = parseRecentText(row.parts)
    if (!id || !role || !text) continue
    if (role === "assistant" && parentID && !assistants.has(parentID)) {
      assistants.set(parentID, text)
      continue
    }
    if (role !== "user") continue
    users.push({ id, text, created })
  }
  if (!users.length) {
    return `No recent chat messages found for session ${sessionId}. Send a new message first.`
  }
  const hasCreated = users.some((item) => item.created > 0)
  const ordered = hasCreated
    ? users.slice().sort((a, b) => {
      if (a.created !== b.created) return a.created - b.created
      return a.id.localeCompare(b.id)
    })
    : users
  const list = hasCreated
    ? ordered.slice(-safeCount)
    : safeCount === 1
      ? ordered.slice(0, 1)
      : ordered.slice(-safeCount)
  const lines = [`Recent activity for session ${sessionId} (showing ${list.length} of ${users.length}):`]
  for (let i = 0; i < list.length; i++) {
    const item = list[i]
    if (!item) continue
    const reply = assistants.get(item.id) || "(no assistant response yet)"
    lines.push("")
    lines.push(`${i + 1}. You: ${item.text}`)
    lines.push(`   Assistant: ${reply}`)
  }
  return truncateTelegramText(lines.join("\n"), recentPayloadMax)
}

async function sessionExists(config: BridgeConfig, sessionId: string, sourceId = "default"): Promise<boolean> {
  const id = normalizeSessionLookupId(sessionId)
  if (!id) return false
  const cached = cachedSessionLookup(id, sourceId)
  if (cached) return cached.exists
  const loaded = await readSessionInfo(config, id)
  cacheSessionInfo(config, id, loaded, sourceId)
  return loaded.exists
}

function pruneExpiredSessions(now: number) {
  for (const [key, value] of sessions) {
    if (value.expiresAt > now) continue
    sessions.delete(key)
  }
}

function compactSessionId(sessionId: string): string {
  const value = sessionId.trim()
  if (value.length <= 18) return value
  return `${value.slice(0, 10)}...${value.slice(-5)}`
}

function switchButtonText(index: number, sessionRef: string, title: string | undefined, current?: string): string {
  const ref = decodeSessionRef(sessionRef)
  const source = ref?.sourceId || "default"
  const sessionId = ref?.sessionId || sessionRef
  const single = (title || "").replace(/\s+/g, " ").trim()
  const base = compactSessionId(sessionId)
  const tagged = source === "default" ? base : `[${sourceLabel(source)}] ${base}`
  const detail = single ? `${single} (${tagged})` : tagged
  const marker = current?.trim() === sessionRef.trim() ? " [current]" : ""
  return truncateTelegramInlineText(`${index + 1}. ${detail}${marker}`, inlineButtonTextMax)
}

async function switchPicker(runtime: Runtime, chatKey: string, current?: string, requestedPage = 0): Promise<{
  text: string
  replyMarkup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }
}> {
  const list = await switchCandidates(runtime, chatKey, current)
  if (!list.length) {
    return {
      text: "No known sessions for this chat/user mapping yet. Use /new to create one, then run /switch to pick from recent sessions.",
    }
  }
  const maxPage = Math.max(0, Math.ceil(list.length / switchPageSize) - 1)
  const safePage = Math.min(Math.max(requestedPage, 0), maxPage)
  const start = safePage * switchPageSize
  const end = Math.min(start + switchPageSize, list.length)
  const rows = list.slice(start, end)
  const titles = await sessionTitles(runtime, rows)
  const buttons = rows.map((sessionRef, itemIndex) => {
    const index = start + itemIndex
    return [{
      text: switchButtonText(index, sessionRef, titles[itemIndex], current),
      callback_data: switchSelectCallback(index, sessionRef),
    }]
  })
  const nav: Array<{ text: string; callback_data: string }> = []
  if (safePage > 0) {
    nav.push({ text: "Back", callback_data: switchPageCallback(safePage - 1) })
  }
  if (safePage < maxPage) {
    nav.push({ text: "More", callback_data: switchPageCallback(safePage + 1) })
  }
  const replyMarkup = {
    inline_keyboard: nav.length ? [...buttons, nav] : buttons,
  }
  return {
    text: `Recent sessions for this chat/user mapping (${start + 1}-${end} of ${list.length}). Tap a session button to switch instantly, or use /switch [session-id|index].`,
    replyMarkup,
  }
}

async function sessionTitles(runtime: Runtime, list: string[]): Promise<Array<string | undefined>> {
  const titles = await Promise.all(list.slice(0, sessionTitleLookupBatchSize).map((storedRef) => {
    const ref = decodeSessionRef(storedRef)
    if (!ref) return Promise.resolve(undefined)
    const scoped = sourceForSessionRef(runtime, ref)
    if (!scoped) return Promise.resolve(undefined)
    return safeSessionTitle(scoped, ref.sessionId, ref.sourceId)
  }))
  if (list.length <= sessionTitleLookupBatchSize) return titles
  const tail = await sessionTitles(runtime, list.slice(sessionTitleLookupBatchSize))
  return [...titles, ...tail]
}

function resolveSwitchTarget(target: string, list: string[]): { sessionId?: string; error?: string; fromKnownList: boolean } {
  const value = target.trim()
  if (!value) {
    return { error: "Usage: /switch [session-id|index]. Run /switch with no args to pick from recent sessions.", fromKnownList: false }
  }
  if (/^\d+$/.test(value)) {
    const index = Number.parseInt(value, 10)
    if (index < 1 || index > list.length) {
      const range = list.length ? `1-${list.length}` : "none"
      return { error: `Invalid session index: ${value}. Available indices: ${range}.`, fromKnownList: false }
    }
    const sessionId = list[index - 1]
    if (!sessionId) {
      return { error: `Invalid session index: ${value}.`, fromKnownList: false }
    }
    return { sessionId, fromKnownList: true }
  }
  return { sessionId: value, fromKnownList: false }
}

async function handleSwitchCallback(runtime: Runtime, chatId: number, userId: number, callbackId: string, parsed: SwitchCallbackData) {
  const key = telegramSessionKey(chatId, userId)
  const current = await runtime.store.get(key) || sessionFromCache(runtime.config, key)
  if (parsed.action === "page") {
    const picker = await switchPicker(runtime, key, current, parsed.page)
    if (!picker.replyMarkup) {
      await answerCallback(runtime.config, callbackId, "No sessions found.")
      await sendTelegramMessage(runtime.config, chatId, picker.text)
      return
    }
    await answerCallback(runtime.config, callbackId, "Session list updated.")
    await sendTelegramInlineMessage(runtime.config, chatId, picker.text, picker.replyMarkup)
    return
  }

  const list = await switchCandidates(runtime, key, current)
  const next = list[parsed.index]
  if (!next) {
    await answerCallback(runtime.config, callbackId, "That session is no longer available.")
    const picker = await switchPicker(runtime, key, current)
    if (!picker.replyMarkup) {
      await sendTelegramMessage(runtime.config, chatId, picker.text)
      return
    }
    await sendTelegramInlineMessage(runtime.config, chatId, picker.text, picker.replyMarkup)
    return
  }
  if (switchToken(next) !== parsed.token) {
    await answerCallback(runtime.config, callbackId, "That session entry changed. Please pick again.")
    const picker = await switchPicker(runtime, key, current)
    if (!picker.replyMarkup) {
      await sendTelegramMessage(runtime.config, chatId, picker.text)
      return
    }
    await sendTelegramInlineMessage(runtime.config, chatId, picker.text, picker.replyMarkup)
    return
  }
  const ref = decodeSessionRef(next)
  if (!ref) {
    await answerCallback(runtime.config, callbackId, "That session entry is invalid.")
    return
  }
  await runtime.store.set(key, next)
  cacheSession(runtime.config, key, next)
  await rememberSession(runtime, key, next)
  const scoped = sourceForSessionRef(runtime, ref)
  if (!scoped) {
    await answerCallback(runtime.config, callbackId, "That source is no longer available.")
    return
  }
  const title = await safeSessionTitle(scoped, ref.sessionId, ref.sourceId)
  await answerCallback(runtime.config, callbackId, "Switched.")
  await sendTelegramMessage(runtime.config, chatId, `Switched to session: ${formatSessionDisplay(ref.sessionId, title, ref.sourceId)}`)
}

export function cacheSession(config: BridgeConfig, chatId: string, sessionId: string) {
  const now = Date.now()
  const expiresAt = now + config.sessionCacheTtlMs
  sessions.delete(chatId)
  sessions.set(chatId, { id: sessionId, expiresAt })
  pruneExpiredSessions(now)
  for (const key of sessions.keys()) {
    if (sessions.size <= config.sessionCacheMax) return
    sessions.delete(key)
  }
}

export function sessionFromCache(config: BridgeConfig, chatId: string): string | undefined {
  const now = Date.now()
  pruneExpiredSessions(now)

  const cached = sessions.get(chatId)
  if (!cached) return
  if (cached.expiresAt <= now) {
    sessions.delete(chatId)
    return
  }

  cacheSession(config, chatId, cached.id)
  return cached.id
}

async function sessionForChat(runtime: Runtime, chatKey: string): Promise<string> {
  const config = runtime.config
  const mapped = await runtime.store.get(chatKey)
  if (mapped) {
    cacheSession(config, chatKey, mapped)
    rememberSessionWithoutBlocking(runtime, chatKey, mapped)
  }

  const cached = sessionFromCache(config, chatKey)
  if (cached) return cached

  const creating = creatingSessions.get(chatKey)
  if (creating) return creating

  const source = (runtime.defaultSourceId ? runtime.sourceById?.get(runtime.defaultSourceId) : undefined)
    || runtime.sources?.[0]
    || defaultSource(runtime.config)
  const sourceConfigValue = sourceConfig(runtime, source.id)
  if (!sourceConfigValue) {
    throw new Error(`OpenCode session creation failed: source ${sourceLabel(source.id)} is unavailable`)
  }
  const created = createSession(sourceConfigValue)
    .then((id) => {
      const storedRef = encodeSessionRef({ sourceId: source.id, sessionId: id })
      return runtime.store.set(chatKey, storedRef).then(() => {
        cacheSession(config, chatKey, storedRef)
        rememberSessionWithoutBlocking(runtime, chatKey, storedRef)
        creatingSessions.delete(chatKey)
        return storedRef
      })
    })
    .catch((error) => {
      creatingSessions.delete(chatKey)
      throw error
    })

  creatingSessions.set(chatKey, created)
  return created
}

function parsedSessionRef(stored: string | undefined): SessionRef | undefined {
  if (!stored) return
  return decodeSessionRef(stored)
}

export function extractReply(payload: unknown): string {
  const data = payload as {
    parts?: Array<{ type?: string; text?: string }>
  }

  const parts = Array.isArray(data.parts) ? data.parts : []
  const text = parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text || "")
    .join("")
    .trim()

  if (text) return text
  return "I finished processing your request, but there was no text response."
}

async function sendPrompt(config: BridgeConfig, sessionId: string, text: string): Promise<string> {
  const url = opencodeUrl(config, `/session/${sessionId}/message`)
  if (config.directory) {
    url.searchParams.set("directory", config.directory)
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      parts: [{ type: "text", text }],
    }),
    signal: AbortSignal.timeout(60_000),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`OpenCode prompt failed (${res.status}): ${body.slice(0, 300)}`)
  }

  const data = await res.json().catch(() => ({}))
  return extractReply(data)
}

function parseSavedPrompt(value: unknown, fallbackScope: "global" | "project"): SavedPrompt | undefined {
  if (!value || typeof value !== "object") return
  const row = value as Record<string, unknown>
  const id = typeof row.id === "string" ? row.id.trim() : ""
  const title = typeof row.title === "string"
    ? row.title.trim()
    : typeof row.name === "string"
      ? row.name.trim()
      : ""
  const text = typeof row.text === "string"
    ? row.text
    : typeof row.prompt === "string"
      ? row.prompt
      : typeof row.content === "string"
        ? row.content
        : ""
  if (!id || !title || !text) return
  const rawCreated = row.createdAt
  const createdAt = typeof rawCreated === "number" && Number.isFinite(rawCreated)
    ? rawCreated
    : typeof rawCreated === "string" && Number.isFinite(Number(rawCreated))
      ? Number(rawCreated)
      : 0
  const scope = row.scope === "project" || row.scope === "global" ? row.scope : fallbackScope
  return { id, title, text, createdAt, scope }
}

function parseSavedPromptList(raw: unknown, scope: "global" | "project"): SavedPrompt[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((item) => parseSavedPrompt(item, scope))
    .filter((item) => item !== undefined) as SavedPrompt[]
}

function readSavedPromptArray(payload: Record<string, unknown>, field: "global" | "project"): unknown[] | undefined {
  const direct = payload[field]
  if (Array.isArray(direct)) return direct
  if (direct && typeof direct === "object") {
    const nested = (direct as { prompts?: unknown }).prompts
    if (Array.isArray(nested)) return nested
  }
  const grouped = payload.prompts
  if (!grouped || typeof grouped !== "object") return
  const nested = (grouped as { global?: unknown; project?: unknown })[field]
  if (Array.isArray(nested)) return nested
}

function mergeSavedPrompts(globalPrompts: SavedPrompt[], projectPrompts: SavedPrompt[]): SavedPrompt[] {
  const projectIds = new Set(projectPrompts.map((item) => item.id))
  const dedupedGlobal = globalPrompts.filter((item) => !projectIds.has(item.id))
  return [...dedupedGlobal, ...projectPrompts]
    .sort((a, b) => {
      const created = b.createdAt - a.createdAt
      if (created !== 0) return created
      return a.id.localeCompare(b.id)
    })
}

function sessionDirectoryFromPayload(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return
  const row = raw as { directory?: unknown; info?: unknown }
  const direct = typeof row.directory === "string" ? row.directory.trim() : ""
  if (direct) return direct
  if (!row.info || typeof row.info !== "object") return
  const info = row.info as { directory?: unknown }
  const nested = typeof info.directory === "string" ? info.directory.trim() : ""
  if (nested) return nested
}

async function sessionDirectory(config: BridgeConfig, sessionId: string): Promise<string | undefined> {
  const id = sessionId.trim()
  if (!id) return
  const lookup = async (withConfiguredDirectory: boolean) => {
    const url = opencodeUrl(config, `/session/${encodeURIComponent(id)}`)
    if (withConfiguredDirectory && config.directory) {
      url.searchParams.set("directory", config.directory)
    }
    const res = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(12_000),
    }).catch(() => undefined)
    if (!res?.ok) return
    const data = await res.json().catch(() => ({}))
    return sessionDirectoryFromPayload(data)
  }

  const first = await lookup(true)
  if (first) return first
  if (!config.directory) return
  return lookup(false)
}

async function savedPromptsForDirectory(config: BridgeConfig, directory?: string) {
  const url = opencodeUrl(config, "/api/ext/saved-prompts")
  if (directory) {
    url.searchParams.set("directory", directory)
  }
  const res = await fetch(url, {
    method: "GET",
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`OpenCode saved prompts failed (${res.status}): ${body.slice(0, 300)}`)
  }
  const data = await res.json().catch(() => undefined) as Record<string, unknown> | undefined
  if (!data || typeof data !== "object") {
    throw new Error("OpenCode saved prompts failed (invalid response): endpoint did not return JSON")
  }
  const global = readSavedPromptArray(data, "global")
  const project = readSavedPromptArray(data, "project")
  if (!global || !project) {
    throw new Error("OpenCode saved prompts failed (invalid response): missing global/project arrays")
  }
  return {
    global: parseSavedPromptList(global, "global"),
    project: parseSavedPromptList(project, "project"),
  }
}

function savedPromptsStatus(error: unknown): number | undefined {
  if (!(error instanceof Error)) return
  const match = error.message.match(/^OpenCode saved prompts failed \((\d+)\):/)
  if (!match) return
  const status = Number.parseInt(match[1] || "", 10)
  if (!Number.isFinite(status)) return
  return status
}

function savedPromptsFailureGuidance(error: unknown, directory?: string): string {
  const status = savedPromptsStatus(error)
  if (error instanceof Error && error.message.includes("(invalid response):")) {
    return "Saved prompts endpoint returned an unexpected response. Check Telegram bridge openCodeUrl and point it to the OpenCode API server that exposes /api/ext endpoints."
  }
  if (status === 403 && directory) {
    return `OpenCode rejected saved prompts access for directory ${directory} (HTTP 403). Run /status in a session mapped to the right project, or update Telegram directory in bridge settings.`
  }
  if (status === 403) {
    return "OpenCode rejected saved prompts access (HTTP 403). Check bridge permissions, then run /prompts again."
  }
  if (directory) {
    return `Saved prompts for directory ${directory} are temporarily unavailable. Try /prompts again, or run /status to verify your active session mapping.`
  }
  return "Saved prompts are temporarily unavailable. Try /prompts again in a moment."
}

async function savedPrompts(runtime: Runtime, key: string): Promise<{ prompts: SavedPrompt[]; guidance?: string }> {
  const config = runtime.config
  const noPromptsGuidance = "No saved prompts found. If your prompts are project-scoped, run /status in the target project first or configure Telegram directory in bridge settings."
  const current = await runtime.store.get(key) || sessionFromCache(config, key)
  const parsed = parsedSessionRef(current)
  const scoped = parsed ? sourceForSessionRef(runtime, parsed) : config
  const promptConfig = scoped || config
  const bySession = parsed && scoped ? await sessionDirectory(scoped, parsed.sessionId) : undefined
  const candidates = [bySession, promptConfig.directory]
    .filter((value): value is string => Boolean(value))
    .filter((value, index, list) => list.indexOf(value) === index)
  const contexts = [...candidates, undefined]
  let fallbackGuidance: string | undefined
  let hasSuccess = false

  for (const directory of contexts) {
    const scopedPrompts = await savedPromptsForDirectory(promptConfig, directory).catch((error) => {
      fallbackGuidance = savedPromptsFailureGuidance(error, directory)
      return
    })
    if (!scopedPrompts) continue
    hasSuccess = true
    const merged = mergeSavedPrompts(scopedPrompts.global, scopedPrompts.project)
    if (merged.length) {
      return { prompts: merged }
    }
  }

  return {
    prompts: [],
    guidance: hasSuccess ? noPromptsGuidance : fallbackGuidance || noPromptsGuidance,
  }
}

function promptScope(scope: SavedPrompt["scope"]): string {
  if (scope === "project") return "project"
  return "global"
}

function promptChoice(prompt: SavedPrompt, index: number): string {
  return `${index + 1}. ${prompt.title} [${promptScope(prompt.scope)}] (${prompt.id})`
}

function promptsMarkup(prompts: SavedPrompt[]): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } | undefined {
  const rows = prompts
    .map((prompt) => {
      const callback = promptCallbackData(prompt.id)
      if (!callback) return
      const title = prompt.title.trim()
      if (!title) return
      return { title, callback_data: callback }
    })
    .filter((item) => item !== undefined)
    .slice(0, inlineButtonMaxOptions)
    .map((item) => [{
      text: item.title.slice(0, inlineButtonTextMax),
      callback_data: item.callback_data,
    }])
  if (!rows.length) return
  return {
    inline_keyboard: rows as Array<Array<{ text: string; callback_data: string }>>,
  }
}

function promptsListText(prompts: SavedPrompt[], guidance?: string): string {
  if (!prompts.length) {
    return guidance || "No saved prompts found. Create one in the web UI, then run /prompts again."
  }
  const shown = prompts.slice(0, 25)
  const lines = shown.map(promptChoice)
  const extra = prompts.length - shown.length
  const suffix = extra > 0 ? `\n+${extra} more prompt(s). Refine with /prompt <name|id>.` : ""
  return `Saved prompts:\n${lines.join("\n")}\n\nUse /prompt <name|id> to run one.${suffix}`
}

function lookupSavedPrompt(input: string, prompts: SavedPrompt[]): { prompt?: SavedPrompt; error?: string } {
  const value = input.trim()
  if (!value) {
    return { error: "Usage: /prompt <name|id>" }
  }
  const byId = prompts.find((item) => item.id === value)
  if (byId) {
    return { prompt: byId }
  }
  const lowered = value.toLowerCase()
  const exact = prompts.filter((item) => item.title.trim().toLowerCase() === lowered)
  if (exact.length === 1) {
    return { prompt: exact[0] }
  }
  if (exact.length > 1) {
    const options = exact.slice(0, 8).map((item, index) => promptChoice(item, index))
    return {
      error: `Multiple prompts match \"${value}\":\n${options.join("\n")}\nUse /prompt <id> to pick one.`,
    }
  }
  const partial = prompts.filter((item) => item.title.toLowerCase().includes(lowered))
  if (partial.length === 1) {
    return { prompt: partial[0] }
  }
  if (partial.length > 1) {
    const options = partial.slice(0, 8).map((item, index) => promptChoice(item, index))
    return {
      error: `Multiple prompts match \"${value}\":\n${options.join("\n")}\nUse /prompt <id> to pick one.`,
    }
  }
  return {
    error: `Saved prompt not found: ${value}. Use /prompts to list available options.`,
  }
}

async function runSavedPrompt(runtime: Runtime, chatId: number, key: string, prompt: SavedPrompt) {
  const storedRef = await sessionForChat(runtime, key)
  const ref = parsedSessionRef(storedRef)
  if (!ref) {
    await sendTelegramMessage(runtime.config, chatId, "Could not resolve the active source for this chat. Use /new and try again.")
    return
  }
  const config = sourceForSessionRef(runtime, ref)
  if (!config) {
    await sendTelegramMessage(runtime.config, chatId, sourceUnavailableText(ref.sourceId))
    return
  }
  await resolvePendingForSession(runtime, chatId, ref.sessionId, ref.sourceId)
  const reply = await sendPrompt(config, ref.sessionId, prompt.text).catch(async (error) => {
    if (!isMissingSession(error)) {
      throw error
    }
    sessions.delete(key)
    await runtime.store.delete(key)
    const nextStored = await sessionForChat(runtime, key)
    const next = parsedSessionRef(nextStored)
    if (!next) {
      throw new Error("OpenCode prompt failed: active source is unavailable")
    }
    const nextConfig = sourceForSessionRef(runtime, next)
    if (!nextConfig) {
      throw new Error(`OpenCode prompt failed: source ${sourceLabel(next.sourceId)} is unavailable`)
    }
    return sendPrompt(nextConfig, next.sessionId, prompt.text)
  })
  await sendTelegramMessage(config, chatId, reply)
}

function isMissingQuestion(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.message.startsWith("OpenCode question reply failed (404):")) return true
  if (error.message.startsWith("OpenCode question reply failed (410):")) return true
  return false
}

async function sendQuestionReply(
  config: BridgeConfig,
  requestId: string,
  answers: string[][],
): Promise<void> {
  const run = async () => {
    const url = opencodeUrl(config, `/question/${encodeURIComponent(requestId)}/reply`)
    if (config.directory) {
      url.searchParams.set("directory", config.directory)
    }
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      throw new Error(`OpenCode question reply failed (${res.status}): ${body.slice(0, 300)}`)
    }
  }

  return retry("opencode:question.reply", run, 2, 400, (error) => {
    if (isMissingQuestion(error)) return false
    if (!(error instanceof Error)) return true
    const match = error.message.match(/^OpenCode question reply failed \((\d+)\):/)
    if (!match) return true
    const status = Number.parseInt(match[1] || "", 10)
    if (!Number.isFinite(status)) return true
    if (status === 408 || status === 429) return true
    if (status >= 400 && status < 500) return false
    return true
  })
}

function chunks(input: string, size: number): string[] {
  if (input.length <= size) return [input]
  const output: string[] = []
  for (let i = 0; i < input.length; i += size) {
    output.push(input.slice(i, i + size))
  }
  return output
}

async function sendTelegramMessage(config: BridgeConfig, chatId: number, text: string) {
  const safe = text || "I could not produce a response."
  for (const part of chunks(safe, telegramMessageSoftLimit)) {
    await telegramRequest(config, "sendMessage", {
      chat_id: chatId,
      text: part,
    })
  }
}

async function sendTelegramInlineMessage(
  config: BridgeConfig,
  chatId: number,
  text: string,
  replyMarkup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> },
) {
  await sendTelegramMessageWithMarkup(config, chatId, text, replyMarkup)
}

async function sendTelegramMessageWithMarkup(
  config: BridgeConfig,
  chatId: number,
  text: string,
  markup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> },
) {
  const safe = text || "I could not produce a response."
  const parts = chunks(safe, telegramMessageSoftLimit)
  for (const [i, part] of parts.entries()) {
    await telegramRequest(config, "sendMessage", {
      chat_id: chatId,
      text: part,
      ...(i === 0 ? { reply_markup: markup } : {}),
    })
  }
}

async function checkTelegramApi(config: BridgeConfig): Promise<BridgeHealthCheck> {
  const url = `https://api.telegram.org/bot${config.token}/getMe`
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(6_000),
  }).catch(() => undefined)
  if (!res) {
    return { status: "error", message: "Telegram API is unreachable" }
  }
  if (!res.ok) {
    return { status: "error", message: `Telegram API returned HTTP ${res.status}` }
  }
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean }
  if (body.ok !== true) {
    return { status: "error", message: "Telegram API rejected bridge credentials" }
  }
  return { status: "ok", message: "Telegram API is reachable" }
}

async function checkOpenCodeApi(config: BridgeConfig): Promise<BridgeHealthCheck> {
  const url = opencodeUrl(config, "/session/status")
  if (config.directory) {
    url.searchParams.set("directory", config.directory)
  }
  const res = await fetch(url, {
    signal: AbortSignal.timeout(6_000),
  }).catch(() => undefined)
  if (!res) {
    return { status: "error", message: "OpenCode API is unreachable" }
  }
  if (!res.ok) {
    return { status: "error", message: `OpenCode API returned HTTP ${res.status}` }
  }
  return { status: "ok", message: "OpenCode API is reachable" }
}

export async function readTelegramBridgeHealth(runtime: Runtime): Promise<BridgeHealthReport> {
  const sources = runtime.sources || configuredSources(runtime.config)
  const [telegramApi, sourceChecks] = await Promise.all([
    checkTelegramApi(runtime.config),
    Promise.all(sources.map(async (source) => {
      const scoped = sourceConfig(runtime, source.id)
      if (!scoped) {
        return {
          sourceId: source.id,
          status: "error" as const,
          message: `Source ${sourceLabel(source.id)} is no longer configured`,
        }
      }
      const status = await checkOpenCodeApi(scoped)
      return {
        sourceId: source.id,
        ...status,
      }
    })),
  ])
  const openCodeApi = sourceChecks.every((item) => item.status === "ok")
    ? { status: "ok" as const, message: `OpenCode API is reachable for ${sourceChecks.length} source(s)` }
    : { status: "error" as const, message: `OpenCode API check failed for ${sourceChecks.filter((item) => item.status !== "ok").length} source(s)` }
  const healthy = telegramApi.status === "ok" && sourceChecks.every((item) => item.status === "ok")
  return {
    status: healthy ? "healthy" : "degraded",
    checkedAt: new Date().toISOString(),
    process: {
      status: "up",
      pid: process.pid,
      uptimeSec: Math.max(0, Math.floor((Date.now() - startedAt) / 1_000)),
      mode: runtime.config.mode,
    },
    config: {
      status: "ok",
      tokenConfigured: Boolean(runtime.config.token),
      webhookSecretConfigured: Boolean(runtime.config.webhookSecret),
      openCodeUrlConfigured: Boolean(runtime.config.openCodeUrl),
      sessionStorePathConfigured: Boolean(runtime.config.sessionStorePath),
      directoryConfigured: Boolean(runtime.config.directory),
      mode: runtime.config.mode,
    },
    dependencies: {
      telegramApi,
      openCodeApi,
      openCodeSources: sourceChecks,
    },
  }
}

async function sendTelegramQuestionPrompt(config: BridgeConfig, chatId: number, question: TelegramPendingQuestion) {
  const markup = questionMarkup(question)
  if (!markup) {
    await sendTelegramMessage(config, chatId, questionStepText(question, false))
    return
  }
  const text = truncateTelegramText(questionStepText(question, true), telegramMessageSoftLimit)
  await telegramRequest(config, "sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: markup,
  })
}

async function answerCallback(config: BridgeConfig, callbackId: string, text: string) {
  await telegramRequest(config, "answerCallbackQuery", {
    callback_query_id: callbackId,
    text,
    show_alert: false,
  })
}

export async function handleCallbackUpdate(runtime: Runtime, update: TelegramUpdate) {
  const callback = update.callback_query
  const chatId = callback?.message?.chat?.id
  const userId = callback?.from?.id
  const callbackId = callback?.id
  const data = callback?.data?.trim() || ""
  if (!callbackId) return
  const state = { acknowledged: false }
  try {
    if (!chatId || !userId || !data) {
      await answerCallback(runtime.config, callbackId, "This button could not be processed.")
      state.acknowledged = true
      return
    }
    const switchParsed = parseSwitchCallbackData(data)
    if (switchParsed) {
      await handleSwitchCallback(runtime, chatId, userId, callbackId, switchParsed)
      state.acknowledged = true
      return
    }
    const utility = parseUtilityCallbackData(data)
    if (utility?.action === "switch") {
      const storedRef = resolveUtilitySwitchTarget(utility.token)
      if (!storedRef) {
        await answerCallback(runtime.config, callbackId, "This switch button expired. Use /switch.")
        state.acknowledged = true
        return
      }
      const ref = decodeSessionRef(storedRef)
      if (!ref) {
        await answerCallback(runtime.config, callbackId, "That session entry is invalid.")
        state.acknowledged = true
        return
      }
      const scoped = sourceForSessionRef(runtime, ref)
      if (!scoped) {
        await answerCallback(runtime.config, callbackId, sourceUnavailableText(ref.sourceId))
        state.acknowledged = true
        return
      }
      const key = telegramSessionKey(chatId, userId)
      await runtime.store.set(key, storedRef)
      cacheSession(runtime.config, key, storedRef)
      await rememberSession(runtime, key, storedRef)
      const title = await safeSessionTitle(scoped, ref.sessionId, ref.sourceId)
      await answerCallback(runtime.config, callbackId, "Switched.")
      state.acknowledged = true
      await sendTelegramMessage(runtime.config, chatId, `Switched to session: ${formatSessionDisplay(ref.sessionId, title, ref.sourceId)}`)
      return
    }
    if (utility?.action === "recent") {
      const key = telegramSessionKey(chatId, userId)
      const current = await runtime.store.get(key) || sessionFromCache(runtime.config, key)
      if (!current) {
        await answerCallback(runtime.config, callbackId, "No active session mapping.")
        state.acknowledged = true
        return
      }
      const ref = parsedSessionRef(current)
      if (!ref) {
        await answerCallback(runtime.config, callbackId, "Session mapping is invalid.")
        state.acknowledged = true
        return
      }
      const scoped = sourceForSessionRef(runtime, ref)
      if (!scoped) {
        await answerCallback(runtime.config, callbackId, sourceUnavailableText(ref.sourceId))
        state.acknowledged = true
        return
      }
      await answerCallback(runtime.config, callbackId, "Loading latest message...")
      state.acknowledged = true
      const text = await recentText(scoped, ref.sessionId, 1)
      await sendTelegramMessage(runtime.config, chatId, text)
      return
    }
    const parsed = parseCallbackData(data)
    if (!parsed) {
      await answerCallback(runtime.config, callbackId, "Unsupported button payload.")
      state.acknowledged = true
      return
    }

    if (parsed.kind === "notify") {
      const key = notificationKey(chatId)
      await answerCallback(runtime.config, callbackId, notifyCallbackAckText)
      state.acknowledged = true
      if (parsed.mode === "on") {
        await setNotificationEnabled(runtime, key, true)
      }
      if (parsed.mode === "off") {
        await setNotificationEnabled(runtime, key, false)
      }
      const enabled = await notificationEnabled(runtime, key)
      await sendTelegramMessageWithMarkup(runtime.config, chatId, notifyText(enabled, parsed.mode), notifyMarkup(enabled))
      return
    }

    if (parsed.kind === "prompt") {
      const key = telegramSessionKey(chatId, userId)
      await answerCallback(runtime.config, callbackId, promptCallbackAckText)
      state.acknowledged = true
      const list = await savedPrompts(runtime, key)
      if (!list.prompts.length) {
        await sendTelegramMessage(runtime.config, chatId, list.guidance || "No saved prompts found. Run /prompts to refresh the list.")
        return
      }
      const selected = list.prompts.find((item) => item.id === parsed.promptId)
      if (!selected) {
        await sendTelegramMessage(runtime.config, chatId, "That saved prompt is no longer available. Run /prompts to refresh the list.")
        return
      }
      await runSavedPrompt(runtime, chatId, key, selected)
      return
    }

    const match = await pendingLookupKeys(chatId, userId)
      .reduce(async (found, itemKey) => {
        const previous = await found
        if (previous) return previous
        const queue = await readPendingQuestionsByKey(runtime, itemKey)
        const pending = queue.find((item) => item.callbackId === parsed.callbackId)
        if (!pending) return
        return { itemKey, pending }
      }, Promise.resolve(undefined as { itemKey: string; pending: TelegramPendingQuestion } | undefined))
    if (!match) {
      await answerCallback(runtime.config, callbackId, "This question has expired.")
      state.acknowledged = true
      await sendTelegramMessage(runtime.config, chatId, "That question is no longer pending. Wait for the next prompt or use /status.")
      return
    }

    const pending = match.pending
    const index = pendingQuestionIndex(pending)
    if (parsed.questionIndex !== index) {
      await answerCallback(runtime.config, callbackId, "That step has already been answered.")
      state.acknowledged = true
      await sendTelegramQuestionPrompt(runtime.config, chatId, pending)
      return
    }
    const row = pending.questions[index]
    const option = row?.options[parsed.optionIndex]
    if (row?.multiple) {
      await answerCallback(runtime.config, callbackId, "Use text reply for this question.")
      state.acknowledged = true
      await sendTelegramMessage(runtime.config, chatId, `${questionAnswerGuidance(pending)}\n\n${questionStepText(pending)}`)
      return
    }
    if (!row || !option) {
      await answerCallback(runtime.config, callbackId, "That option is no longer available.")
      state.acknowledged = true
      await sendTelegramQuestionPrompt(runtime.config, chatId, pending)
      return
    }

    const answers = nextAnswers(pending, [option])
    if (!answers) {
      await answerCallback(runtime.config, callbackId, "This question has expired.")
      state.acknowledged = true
      await deletePendingQuestionByKey(runtime, match.itemKey, pending.requestId)
      await sendTelegramMessage(runtime.config, chatId, "That question is no longer pending. Wait for the next prompt or use /status.")
      return
    }
    await answerCallback(runtime.config, callbackId, callbackAckText)
    state.acknowledged = true
    if (answers.length < pending.questions.length) {
      await upsertPendingQuestion(runtime, match.itemKey, withAnswers(pending, answers))
      const next = await readPendingQuestionsByKey(runtime, match.itemKey)
        .then((rows) => rows.find((item) => item.requestId === pending.requestId))
      if (!next) {
        await sendTelegramMessage(runtime.config, chatId, "That question is no longer pending. Wait for the next prompt or use /status.")
        return
      }
      await sendTelegramMessage(runtime.config, chatId, "Thanks, answer recorded.")
      await sendTelegramQuestionPrompt(runtime.config, chatId, next)
      return
    }
    const pendingSource = pending.sourceId || "default"
    const replyConfig = sourceConfig(runtime, pendingSource)
    if (!replyConfig) {
      await sendTelegramMessage(runtime.config, chatId, sourceUnavailableText(pendingSource))
      return
    }
    await sendQuestionReply(replyConfig, pending.requestId, answers)
      .then(async () => {
        await deletePendingQuestionByKey(runtime, match.itemKey, pending.requestId)
        const remaining = await readPendingQuestionsByKey(runtime, match.itemKey)
        if (remaining.length) {
          const next = remaining[0]
          if (next) {
            await sendTelegramQuestionPrompt(runtime.config, chatId, next)
          }
          return
        }
        await sendTelegramMessage(runtime.config, chatId, "Thanks, your answer was sent.")
      })
      .catch(async (error) => {
        if (!isMissingQuestion(error)) throw error
        await deletePendingQuestionByKey(runtime, match.itemKey, pending.requestId)
        await sendTelegramMessage(runtime.config, chatId, "That question is no longer pending. Wait for the next prompt or use /status.")
      })
  } catch (error) {
    console.error("[TelegramBridge] callback handling failed", { chatId, userId, callbackId, error })
    const recovery = [
      ...(state.acknowledged ? [] : [answerCallback(runtime.config, callbackId, "Sorry, this button could not be processed right now.")]),
      ...(!chatId
        ? []
        : [sendTelegramMessage(runtime.config, chatId, "Sorry, something went wrong while processing that button. Please try again or reply with text.")]),
    ]
    await Promise.allSettled(recovery)
  }
}

export async function handleTelegramUpdate(runtime: Runtime, update: TelegramUpdate) {
  if (update.callback_query) {
    await handleCallbackUpdate(runtime, update)
    return
  }
  await handleTextUpdate(runtime, update)
}

export async function handleTextUpdate(runtime: Runtime, update: TelegramUpdate) {
  const config = runtime.config
  const message = update.message
  const chatId = message?.chat?.id
  const userId = message?.from?.id
  const text = message?.text?.trim()

  if (!chatId || !text) return

  const key = telegramSessionKey(chatId, userId)

  const runCommand = async () => {
    const command = parseCommand(text)
    if (!command) return false
    const known = commandEntry(command.name)
    if (known?.name === "help") {
      await sendTelegramMessage(config, chatId, helpText())
      return true
    }
    if (known?.name === "status") {
      const storedRef = await sessionForChat(runtime, key)
      const ref = parsedSessionRef(storedRef)
      if (!ref) {
        await sendTelegramMessage(config, chatId, "Current session mapping is invalid. Use /new to create a fresh session.")
        return true
      }
      const scoped = sourceForSessionRef(runtime, ref)
      if (!scoped) {
        await sendTelegramMessage(config, chatId, sourceUnavailableText(ref.sourceId))
        return true
      }
      const title = await safeSessionTitle(scoped, ref.sessionId, ref.sourceId)
      await sendTelegramMessage(config, chatId, `Current session: ${formatSessionDisplay(ref.sessionId, title, ref.sourceId)}`)
      return true
    }
    if (known?.name === "new") {
      const source = (runtime.defaultSourceId ? runtime.sourceById?.get(runtime.defaultSourceId) : undefined)
        || runtime.sources?.[0]
        || defaultSource(runtime.config)
      const scoped = sourceConfig(runtime, source.id)
      if (!scoped) {
        await sendTelegramMessage(config, chatId, sourceUnavailableText(source.id))
        return true
      }
      const sessionId = await createSession(scoped)
      const next = encodeSessionRef({ sourceId: source.id, sessionId })
      await runtime.store.set(key, next)
      cacheSession(config, key, next)
      await rememberSession(runtime, key, next)
      await sendTelegramMessage(config, chatId, `Started a new session: ${formatSessionDisplay(sessionId, undefined, source.id)}`)
      return true
    }
    if (known?.name === "sessions") {
      const current = await runtime.store.get(key) || sessionFromCache(config, key)
      await sendTelegramMessage(config, chatId, await sessionsText(runtime, key, current))
      return true
    }
    if (known?.name === "recent") {
      const parsed = normalizeRecentCount(command.args)
      if (parsed.error) {
        await sendTelegramMessage(config, chatId, parsed.error)
        return true
      }
      const current = await runtime.store.get(key) || sessionFromCache(config, key)
      if (!current) {
        await sendTelegramMessage(config, chatId, "No active session mapping for this chat/user yet. Use /status or /new first.")
        return true
      }
      const ref = parsedSessionRef(current)
      if (!ref) {
        await sendTelegramMessage(config, chatId, "Current session mapping is invalid. Use /new to create a fresh session.")
        return true
      }
      const scoped = sourceForSessionRef(runtime, ref)
      if (!scoped) {
        await sendTelegramMessage(config, chatId, sourceUnavailableText(ref.sourceId))
        return true
      }
      const text = await recentText(scoped, ref.sessionId, parsed.count || recentDefaultCount)
      await sendTelegramMessage(config, chatId, text)
      return true
    }
    if (known?.name === "switch") {
      const target = command.args.join(" ").trim()
      if (!target) {
        const current = await runtime.store.get(key) || sessionFromCache(config, key)
        const picker = await switchPicker(runtime, key, current)
        if (!picker.replyMarkup) {
          await sendTelegramMessage(config, chatId, picker.text)
          return true
        }
        await sendTelegramInlineMessage(config, chatId, picker.text, picker.replyMarkup)
        return true
      }
      const current = await runtime.store.get(key) || sessionFromCache(config, key)
      const list = await switchCandidates(runtime, key, current)
      const resolved = resolveSwitchTarget(target, list)
      if (resolved.error) {
        await sendTelegramMessage(config, chatId, resolved.error)
        return true
      }
      const next = resolved.sessionId
      if (!next) {
        await sendTelegramMessage(config, chatId, "Usage: /switch [session-id|index]. Run /switch with no args to pick from recent sessions.")
        return true
      }
      const nextRef = (() => {
        const parsed = parsedSessionRef(next)
        if (parsed) return parsed
        const currentRef = parsedSessionRef(current)
        const sourceId = currentRef?.sourceId || runtime.defaultSourceId || "default"
        return { sourceId, sessionId: next }
      })()
      const nextConfig = sourceForSessionRef(runtime, nextRef)
      if (!nextConfig) {
        await sendTelegramMessage(config, chatId, sourceUnavailableText(nextRef.sourceId))
        return true
      }
      if (!resolved.fromKnownList && !(await sessionExists(nextConfig, nextRef.sessionId, nextRef.sourceId))) {
        await sendTelegramMessage(config, chatId, `Session not found: ${next}. Use /sessions to select a known session or /new to create one.`)
        return true
      }
      const storedRef = resolved.fromKnownList ? next : encodeSessionRef(nextRef)
      await runtime.store.set(key, storedRef)
      cacheSession(config, key, storedRef)
      await rememberSession(runtime, key, storedRef)
      const title = await safeSessionTitle(nextConfig, nextRef.sessionId, nextRef.sourceId)
      await sendTelegramMessage(config, chatId, `Switched to session: ${formatSessionDisplay(nextRef.sessionId, title, nextRef.sourceId)}`)
      return true
    }
    if (known?.name === "notify") {
      const mode = command.args[0]?.toLowerCase() || ""
      const notifyKey = notificationKey(chatId)
      if (mode === "on") {
        await setNotificationEnabled(runtime, notifyKey, true)
        const enabled = await notificationEnabled(runtime, notifyKey)
        await sendTelegramMessageWithMarkup(config, chatId, notifyText(enabled, "on"), notifyMarkup(enabled))
        return true
      }
      if (mode === "off") {
        await setNotificationEnabled(runtime, notifyKey, false)
        const enabled = await notificationEnabled(runtime, notifyKey)
        await sendTelegramMessageWithMarkup(config, chatId, notifyText(enabled, "off"), notifyMarkup(enabled))
        return true
      }
      if (mode === "status" || !mode) {
        const enabled = await notificationEnabled(runtime, notifyKey)
        await sendTelegramMessageWithMarkup(config, chatId, notifyText(enabled, "status"), notifyMarkup(enabled))
        return true
      }
      await sendTelegramMessage(config, chatId, "Usage: /notify on, /notify off, or /notify status")
      return true
    }
    if (known?.name === "pending" || known?.name === "inbox") {
      const items = await pendingGet(runtime, pendingChatKey(chatId))
      await sendTelegramMessage(config, chatId, pendingMessage(items))
      return true
    }
    if (known?.name === "prompts") {
      const list = await savedPrompts(runtime, key)
      const text = promptsListText(list.prompts, list.guidance)
      const markup = promptsMarkup(list.prompts)
      if (!markup) {
        await sendTelegramMessage(config, chatId, text)
        return true
      }
      await sendTelegramMessageWithMarkup(config, chatId, text, markup)
      return true
    }
    if (known?.name === "prompt") {
      const target = command.args.join(" ").trim()
      if (!target) {
        await sendTelegramMessage(config, chatId, "Usage: /prompt <name|id>")
        return true
      }
      const list = await savedPrompts(runtime, key)
      if (!list.prompts.length && list.guidance) {
        await sendTelegramMessage(config, chatId, list.guidance)
        return true
      }
      const resolved = lookupSavedPrompt(target, list.prompts)
      if (resolved.error) {
        await sendTelegramMessage(config, chatId, resolved.error)
        return true
      }
      const selected = resolved.prompt
      if (!selected) {
        await sendTelegramMessage(config, chatId, "Usage: /prompt <name|id>")
        return true
      }
      await runSavedPrompt(runtime, chatId, key, selected)
      return true
    }
    const suggestions = commandSuggestions(command.name)
    const suggestionText = suggestions.length
      ? `Try ${suggestions.join(", ")} or use /help.`
      : `Use /help to view ${commandNames().join(", ")}.`
    await sendTelegramMessage(config, chatId, `Unknown command ${command.name}. ${suggestionText}`)
    return true
  }

  try {
    const handled = await runCommand()
    if (handled) return

    const match = await readPendingQuestionMatch(runtime, chatId, userId)
    if (match) {
      const pending = match.pending
      const index = pendingQuestionIndex(pending)
      const row = pending.questions[index]
      const current = row ? answerFromInput(row, text) : undefined
      const complete = parseQuestionAnswers(pending, text)
      const answers = complete || (current ? nextAnswers(pending, current) : undefined)
      if (!answers || answers.length < pending.questions.length && !current) {
        await sendTelegramMessage(config, chatId, `${questionAnswerGuidance(pending)}\n\n${questionStepText(pending)}`)
        return
      }
      if (answers.length < pending.questions.length) {
        await upsertPendingQuestion(runtime, match.itemKey, withAnswers(pending, answers))
        const queue = await readPendingQuestionsByKey(runtime, match.itemKey)
        const next = queue.find((item) => item.requestId === pending.requestId)
        if (!next) {
          await sendTelegramMessage(config, chatId, "That question is no longer pending. Wait for the next prompt or use /status.")
          return
        }
        await sendTelegramMessage(config, chatId, "Thanks, answer recorded.")
        await sendTelegramQuestionPrompt(config, chatId, next)
        return
      }
      const pendingSource = pending.sourceId || "default"
      const replyConfig = sourceConfig(runtime, pendingSource)
      if (!replyConfig) {
        await sendTelegramMessage(config, chatId, sourceUnavailableText(pendingSource))
        return
      }
      await sendQuestionReply(replyConfig, pending.requestId, answers)
        .then(async () => {
          await deletePendingQuestionByKey(runtime, match.itemKey, pending.requestId)
          const remaining = await readPendingQuestionsByKey(runtime, match.itemKey)
          if (remaining.length) {
            const next = remaining[0]
            if (next) {
              await sendTelegramMessage(config, chatId, "Thanks, answer recorded.")
              await sendTelegramQuestionPrompt(config, chatId, next)
            }
            return
          }
          await sendTelegramMessage(config, chatId, "Thanks, your answer was sent.")
        })
        .catch(async (error) => {
          if (!isMissingQuestion(error)) throw error
          await deletePendingQuestionByKey(runtime, match.itemKey, pending.requestId)
          await sendTelegramMessage(config, chatId, "That question is no longer pending. Wait for the next prompt or use /status.")
        })
      return
    }

    const storedRef = await sessionForChat(runtime, key)
    const ref = parsedSessionRef(storedRef)
    if (!ref) {
      await sendTelegramMessage(config, chatId, "Current session mapping is invalid. Use /new to create a fresh session.")
      return
    }
    const scoped = sourceForSessionRef(runtime, ref)
    if (!scoped) {
      await sendTelegramMessage(config, chatId, sourceUnavailableText(ref.sourceId))
      return
    }
    await resolvePendingForSession(runtime, chatId, ref.sessionId, ref.sourceId)
    const reply = await sendPrompt(scoped, ref.sessionId, text).catch(async (error) => {
      if (!isMissingSession(error)) {
        throw error
      }
      sessions.delete(key)
      await runtime.store.delete(key)
      const nextStored = await sessionForChat(runtime, key)
      const next = parsedSessionRef(nextStored)
      if (!next) {
        throw new Error("OpenCode prompt failed: active source is unavailable")
      }
      const nextConfig = sourceForSessionRef(runtime, next)
      if (!nextConfig) {
        throw new Error(`OpenCode prompt failed: source ${sourceLabel(next.sourceId)} is unavailable`)
      }
      return sendPrompt(nextConfig, next.sessionId, text)
    })
    await sendTelegramMessage(config, chatId, reply)
  } catch (error) {
    console.error("[TelegramBridge] request handling failed", { chatId, error })
    try {
      await sendTelegramMessage(config, chatId, "Sorry, I ran into an internal error. Please try again in a moment.")
    } catch (sendError) {
      console.error("[TelegramBridge] failed to send error response", { chatId, error: sendError })
    }
  }
}

async function notifySessionKeys(
  runtime: Runtime,
  sessionId: string,
  sourceId: string,
  kind: "question" | "permission" | "task-finished",
  text: string,
  requestId?: string,
  notifyKind?: string,
) {
  const ref = { sourceId, sessionId }
  const pending = await pendingTargets(runtime, ref)
  if (!pending.length) return
  const notify = await eventTargets(runtime, ref)
  const notifyChats = new Set<number>()
  for (const key of notify) {
    const parsed = parseTelegramKey(key)
    if (!parsed) continue
    notifyChats.add(parsed.chatId)
  }
  const dedupeKey = notifyKind || kind
  const chats = new Set<number>()
  const proactiveChats = new Set<number>()
  for (const key of pending) {
    try {
      const parsed = parseTelegramKey(key)
      if (!parsed) continue
      const chatId = parsed.chatId
      const entry: TelegramPendingItem = {
        id: pendingEntryId(sessionId, kind, chatId, requestId, sourceId),
        kind,
        sessionId,
        sourceId,
        text,
        stampedAt: Date.now(),
        resolved: kind === "task-finished",
      }
      if (!chats.has(chatId)) {
        chats.add(chatId)
        await appendPending(runtime, chatId, entry)
        if (kind === "task-finished") {
          await resolvePendingForSession(runtime, chatId, sessionId, sourceId)
        }
      }
      if (!notifyChats.has(chatId)) continue
      if (proactiveChats.has(chatId)) continue
      proactiveChats.add(chatId)
      if (!proactiveTelegramEnabled(runtime.config)) continue
      if (!shouldNotify(runtime.config, chatId, dedupeKey, sessionId, sourceId)) continue
      const message = `${text}\n\nOpen ${sessionLabel(runtime.config, sessionId, sourceId)}`
      const markup = proactiveActionsMarkup(kind === "task-finished" ? "task-finished" : "default", sourceId, sessionId)
      await queueChatUpdate(String(chatId), async () => {
        await sendTelegramMessageWithMarkup(runtime.config, chatId, message, markup)
      })
      stampNotification(chatId, dedupeKey, sessionId, sourceId)
    } catch (error) {
      console.error("[TelegramBridge] outbound notify failed", { sessionId, key, kind, error })
    }
  }
}

async function notifyQuestion(runtime: Runtime, sessionId: string, sourceId: string, question: TelegramPendingQuestion) {
  const ref = { sourceId, sessionId }
  const pending = await pendingTargets(runtime, ref)
  if (!pending.length) return
  const notify = await eventTargets(runtime, ref)
  const notifyChats = new Set<number>()
  for (const key of notify) {
    const parsed = parseTelegramKey(key)
    if (!parsed) continue
    notifyChats.add(parsed.chatId)
  }
  const kind = `question:${sourceId}:${question.requestId}`
  const pendingByChat = new Map<number, { key: string; userId?: number }>()
  for (const key of pending) {
    const parsed = parseTelegramKey(key)
    if (!parsed) continue
    const current = pendingByChat.get(parsed.chatId)
    if (!current) {
      pendingByChat.set(parsed.chatId, { key, userId: parsed.userId })
      continue
    }
    if (current.userId !== undefined && parsed.userId === undefined) {
      pendingByChat.set(parsed.chatId, { key, userId: parsed.userId })
    }
  }
  const chats = new Set<number>()
  const proactiveChats = new Set<number>()
  for (const key of pending) {
    try {
      const parsed = parseTelegramKey(key)
      if (!parsed) continue
      const chatId = parsed.chatId
      if (!chats.has(chatId)) {
        chats.add(chatId)
        const pendingKey = pendingByChat.get(chatId)?.key || key
        await upsertPendingQuestion(runtime, pendingKey, question)
        await appendPending(runtime, chatId, {
          id: pendingEntryId(sessionId, "question", chatId, question.requestId, sourceId),
          kind: "question",
          sessionId,
          sourceId,
          text: pendingQuestionText(question),
          stampedAt: Date.now(),
          resolved: false,
        })
      }
      if (!notifyChats.has(chatId)) continue
      if (proactiveChats.has(chatId)) continue
      proactiveChats.add(chatId)
      if (!proactiveTelegramEnabled(runtime.config)) continue
      if (!shouldNotify(runtime.config, chatId, kind, sessionId, sourceId)) continue
      await queueChatUpdate(String(chatId), async () => {
        await sendTelegramQuestionPrompt(runtime.config, chatId, question)
        await sendTelegramMessageWithMarkup(
          runtime.config,
          chatId,
          `Open ${sessionLabel(runtime.config, sessionId, sourceId)}`,
          proactiveActionsMarkup("default", sourceId, sessionId),
        )
      })
      stampNotification(chatId, kind, sessionId, sourceId)
    } catch (error) {
      console.error("[TelegramBridge] outbound question notify failed", { sessionId, key, error })
    }
  }
}

async function handleOutboundBlocks(runtime: Runtime, blocks: string[], sourceId: string) {
  for (const block of blocks) {
    const lines = block.split("\n")
    const dataLines = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
    if (!dataLines.length) continue
    const raw = dataLines.join("\n")
    const event = await Promise.resolve()
      .then(() => parseEvent(raw))
      .catch(() => undefined)
    if (!event) continue
    await handleBridgeEvent(runtime, event, sourceId)
  }
}

export async function consumeOutboundEventStream(runtime: Runtime, body: ReadableStream<Uint8Array>, sourceId = "default") {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const parser = createOutboundSSEParser()
  while (true) {
    const step = await reader.read()
    if (step.done) break
    const blocks = parser.push(decoder.decode(step.value, { stream: true }))
    await handleOutboundBlocks(runtime, blocks, sourceId)
  }

  const finalText = decoder.decode()
  if (finalText) {
    await handleOutboundBlocks(runtime, parser.push(finalText), sourceId)
  }

  const tailBlocks = parser.flush()
  await handleOutboundBlocks(runtime, tailBlocks, sourceId)
}

export async function handleBridgeEvent(runtime: Runtime, event: { type: string; properties: Record<string, unknown> }, sourceId = "default") {
  const sessionId = typeof event.properties.sessionID === "string" ? event.properties.sessionID : ""
  if (event.type === "session.deleted") {
    const info = event.properties.info && typeof event.properties.info === "object"
      ? event.properties.info as { id?: unknown }
      : undefined
    const deletedSessionId = typeof info?.id === "string" ? info.id : sessionId
    if (!deletedSessionId) return
    statusBySession.delete(sourceScopedId(sourceId, deletedSessionId))
    const targets = new Set<string>()
    const mapped = await sessionTargets(runtime, { sourceId, sessionId: deletedSessionId })
    for (const key of mapped) {
      targets.add(key)
    }
    const optedIn = await notificationTargets(runtime)
    for (const key of optedIn) {
      targets.add(key)
    }
    const chats = new Set<number>()
    for (const key of targets) {
      const parsed = parseTelegramKey(key)
      if (!parsed) continue
      if (chats.has(parsed.chatId)) continue
      chats.add(parsed.chatId)
      await resolvePendingForSession(runtime, parsed.chatId, deletedSessionId, sourceId)
    }
    return
  }
  if (!sessionId) return
  if (event.type === "question.asked") {
    const pending = parsePendingQuestion(event.properties, sourceId)
    if (!pending) {
      const requestId = typeof event.properties.id === "string" ? event.properties.id.trim() : ""
      const notifyKind = requestId ? `question:${sourceId}:${requestId}` : undefined
      await notifySessionKeys(
        runtime,
        sessionId,
        sourceId,
        "question",
        `Question pending: ${questionText(event.properties)}`,
        requestId || undefined,
        notifyKind,
      )
      return
    }
    await notifyQuestion(runtime, sessionId, sourceId, pending)
    return
  }
  if (event.type === "permission.asked") {
    const requestId = typeof event.properties.id === "string" ? event.properties.id.trim() : ""
    const notifyKind = requestId ? `permission:${sourceId}:${requestId}` : undefined
    await notifySessionKeys(runtime, sessionId, sourceId, "permission", permissionText(event.properties), requestId || undefined, notifyKind)
    return
  }
  if (event.type !== "session.status") return
  const status = event.properties.status && typeof event.properties.status === "object"
    ? event.properties.status as { type?: unknown }
    : undefined
  const next = typeof status?.type === "string" ? status.type : ""
  const scopedSessionId = sourceScopedId(sourceId, sessionId)
  const prev = statusBySession.get(scopedSessionId)
  if (next !== "idle") {
    statusBySession.set(scopedSessionId, next)
    return
  }
  statusBySession.delete(scopedSessionId)
  if (!prev || prev === "idle") return
  await notifySessionKeys(runtime, sessionId, sourceId, "task-finished", "Task finished: the session is now idle.")
}

async function runOutboundNotifications(runtime: Runtime, source: SourceConfig) {
  const config = sourceConfig(runtime, source.id)
  if (!config) {
    console.warn(`[TelegramBridge] skipping outbound notifications for source=${source.id}: source config unavailable`)
    return
  }
  while (true) {
    const url = opencodeUrl(config, "/event")
    if (config.directory) {
      url.searchParams.set("directory", config.directory)
    }

    try {
      const response = await fetch(url, {
        headers: { Accept: "text/event-stream" },
        signal: AbortSignal.timeout(10 * 60 * 1000),
      })
      if (!response.ok || !response.body) {
        throw new Error(`OpenCode event stream failed (${response.status})`)
      }

      await consumeOutboundEventStream(runtime, response.body, source.id)
    } catch (error) {
      if (isTimeoutError(error)) {
        console.log(`[TelegramBridge] outbound event stream timed out for source=${source.id}, reconnecting`)
        await sleep(1500)
        continue
      }
      console.error(`[TelegramBridge] outbound event stream error for source=${source.id}`, error)
      await sleep(1500)
    }
  }
}

async function runPolling(runtime: Runtime) {
  const config = runtime.config
  console.log("[TelegramBridge] mode=polling")
  await telegramRequest(config, "deleteWebhook", {
    drop_pending_updates: false,
  })
  let offset = 0

  while (true) {
    try {
      const result = (await telegramRequest(
        config,
        "getUpdates",
        {
          offset,
          timeout: 30,
          allowed_updates: ["message", "callback_query"],
        },
        35_000,
      )) as TelegramUpdate[]

      const runs: Promise<void>[] = []
      for (const update of result || []) {
        offset = Math.max(offset, update.update_id + 1)
        const chatId = update.message?.chat?.id
          || update.callback_query?.message?.chat?.id
        const run = !chatId
          ? handleTelegramUpdate(runtime, update)
          : queueChatUpdate(String(chatId), () => handleTelegramUpdate(runtime, update))
        runs.push(run)
      }
      if (runs.length) {
        await Promise.allSettled(runs)
      }
    } catch (error) {
      console.error("[TelegramBridge] polling error", error)
      await sleep(1500)
    }
  }
}

export function runPollingHealthServer(runtime: Runtime): boolean {
  const config = runtime.config
  const host = telegramHealthHost(config.mode)
  try {
    Bun.serve({
      port: config.port,
      hostname: host,
      async fetch(req) {
        const url = new URL(req.url)
        if (req.method !== "GET" || url.pathname !== "/health") {
          return new Response("Not Found", { status: 404 })
        }
        const report = await readTelegramBridgeHealth(runtime)
        return Response.json(report)
      },
    })
  } catch (error) {
    console.warn(`[TelegramBridge] health server failed to start on ${host}:${config.port}`, error)
    return false
  }
  console.log(`[TelegramBridge] health server listening on ${host}:${config.port}`)
  return true
}

async function runWebhook(runtime: Runtime) {
  const config = runtime.config
  if (config.webhookUrl) {
    await telegramRequest(config, "setWebhook", {
      url: config.webhookUrl,
      secret_token: config.webhookSecret,
      allowed_updates: ["message", "callback_query"],
    })
    console.log(`[TelegramBridge] webhook registered: ${config.webhookUrl}`)
  }

  Bun.serve({
    port: config.port,
    hostname: "0.0.0.0",
    async fetch(req, server) {
      const url = new URL(req.url)
      if (req.method === "GET" && url.pathname === "/health") {
        if (!allowTelegramHealthRequest(server.requestIP(req)?.address)) {
          return new Response("Not Found", { status: 404 })
        }
        const report = await readTelegramBridgeHealth(runtime)
        return Response.json(report)
      }
      if (req.method !== "POST" || url.pathname !== config.webhookPath) {
        return new Response("Not Found", { status: 404 })
      }

      if (config.webhookSecret) {
        const secret = req.headers.get("x-telegram-bot-api-secret-token")
        if (secret !== config.webhookSecret) {
          return new Response("Unauthorized", { status: 401 })
        }
      }

      const update = (await req.json().catch(() => null)) as TelegramUpdate | null
      if (!update) {
        return new Response("Bad Request", { status: 400 })
      }

      const chatId = update.message?.chat?.id || update.callback_query?.message?.chat?.id
      const run = !chatId
        ? handleTelegramUpdate(runtime, update)
        : queueChatUpdate(String(chatId), () => handleTelegramUpdate(runtime, update))
      void run.catch((error) => {
        console.error("[TelegramBridge] webhook handling failed", error)
      })
      return Response.json({ ok: true })
    },
  })

  console.log(`[TelegramBridge] mode=webhook port=${config.port} path=${config.webhookPath}`)
}

export async function startTelegramBridge() {
  const config = parseConfig()
  await writeTelegramRuntimeState(config).catch((error) => {
    console.warn("[TelegramBridge] failed to write runtime state", error)
  })
  const store = createTelegramSessionStore(config.sessionStorePath)
  const sources = configuredSources(config)
  const sourceById = new Map(sources.map((source) => [source.id, source]))
  const defaultSourceId = config.multiSourceEnabled
    ? sources.find((source) => source.id !== "default")?.id || "default"
    : "default"
  const runtime = { config, sources, sourceById, defaultSourceId, store }
  console.log(`[TelegramBridge] OpenCode API: ${config.openCodeUrl}`)
  if (config.multiSourceEnabled) {
    console.log(`[TelegramBridge] Multi-source enabled: ${sources.map((source) => `${source.id}=${source.openCodeUrl}`).join(", ")}`)
  }
  console.log(`[TelegramBridge] Session store: ${config.sessionStorePath}`)
  if (config.directory) {
    console.log(`[TelegramBridge] OpenCode directory: ${config.directory}`)
  }
  registerTelegramCommandsWithoutBlocking(config)
  if (config.mode === "polling") {
    runPollingHealthServer(runtime)
    await Promise.all([runPolling(runtime), ...runtime.sources.map((source) => runOutboundNotifications(runtime, source))])
    return
  }

  await Promise.all([runWebhook(runtime), ...runtime.sources.map((source) => runOutboundNotifications(runtime, source))])
}

export function resetSessionCacheForTest() {
  setRetryDelayForTest()
  pendingEntrySeq = 0
  sessions.clear()
  creatingSessions.clear()
  chatQueues.clear()
  eventNotifications.clear()
  statusBySession.clear()
  fallbackNotifications.clear()
  fallbackPending.clear()
  pendingQuestions.clear()
  sessionHistory.clear()
  sessionInfo.clear()
  switchTargets.clear()
}
