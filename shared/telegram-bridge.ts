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
  store: ReturnType<typeof createTelegramSessionStore>
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
  }
}

type TelegramPendingItem = {
  id: string
  kind: "question" | "permission" | "task-finished"
  sessionId: string
  text: string
  stampedAt: number
  resolved: boolean
}

type CachedSession = {
  id: string
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

type TelegramPendingItem = {
  id: string
  kind: "question" | "permission" | "task-finished"
  sessionId: string
  text: string
  stampedAt: number
  resolved: boolean
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

let pendingEntrySeq = 0

const pendingQuestionTtlMs = 30 * 60 * 1000
const startedAt = Date.now()
const pendingRetentionMs = 3 * 24 * 60 * 60 * 1000
const pendingMaxItems = 60
const pendingDigestMax = 8
const pendingTextMax = 240
const sessionHistoryMax = 12
const recentDefaultCount = 5
const recentMaxCount = 12
const recentPartTextMax = 500
const callbackIdLength = 24
const callbackAckText = "Sending answer..."
const inlineButtonMaxOptions = 20
const inlineButtonTextMax = 48
const callbackDataMax = 64
const telegramMessageSoftLimit = 3900
const recentPayloadMax = telegramMessageSoftLimit * 3

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
    args: "<session-id|index>",
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
    return `${index + 1}. [${label}] ${item.text} (${mins}m ago, session ${item.sessionId})`
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

function pendingEntryId(sessionId: string, kind: string, chatId: number, requestId?: string): string {
  const base = requestId?.trim()
  if (base) return `${sessionId}:${kind}:${base}:${chatId}`
  const seq = String(pendingEntrySeq).padStart(8, "0")
  pendingEntrySeq += 1
  return `${sessionId}:${kind}:${Date.now()}:${seq}:${chatId}`
}

function pendingQuestionText(question: TelegramPendingQuestion): string {
  const row = question.questions[0]
  const title = row?.header || row?.question || "The assistant is waiting for your answer."
  const text = `Question pending: ${title}`
  if (text.length <= pendingTextMax) return text
  if (pendingTextMax <= 3) return text.slice(0, pendingTextMax)
  return `${text.slice(0, pendingTextMax - 3)}...`
}

async function resolvePendingForSession(runtime: Runtime, chatId: number, sessionId: string) {
  await queueChatUpdate(`pending:${chatId}`, async () => {
    const key = pendingChatKey(chatId)
    const items = await pendingGet(runtime, key)
    const next = items.map((item) => {
      if (item.sessionId !== sessionId) return item
      if (item.resolved) return item
      if (item.kind === "task-finished") return item
      return { ...item, resolved: true }
    })
    await pendingSet(runtime, key, next)
  })
}

function sessionLabel(config: BridgeConfig, sessionId: string): string {
  if (!config.sessionLinkBase) return `session ${sessionId}`
  return `${config.sessionLinkBase}/session/${encodeURIComponent(sessionId)}`
}

function notificationKey(chatId: number): string {
  return telegramSessionKey(chatId)
}

function proactiveTelegramEnabled(config: BridgeConfig): boolean {
  return config.telegramAlarmChannelEnabled !== false
}

function shouldNotify(config: BridgeConfig, chatId: number, kind: string, sessionId: string): boolean {
  const now = Date.now()
  const cutoff = now - Math.max(config.notificationDebounceMs * 3, 60_000)
  for (const [entryKey, stampedAt] of eventNotifications) {
    if (stampedAt >= cutoff) continue
    eventNotifications.delete(entryKey)
  }
  const key = `${chatId}:${kind}:${sessionId}`
  const previous = eventNotifications.get(key)
  if (previous && now - previous < config.notificationDebounceMs) return false
  return true
}

function stampNotification(chatId: number, kind: string, sessionId: string) {
  eventNotifications.set(`${chatId}:${kind}:${sessionId}`, Date.now())
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

async function readPendingQuestions(runtime: Runtime, chatId: number, userId?: number): Promise<TelegramPendingQuestion[]> {
  const key = pendingKey(chatId, userId)
  return readPendingQuestionsByKey(runtime, key)
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

async function deletePendingQuestion(runtime: Runtime, chatId: number, requestId: string, userId?: number) {
  const key = pendingKey(chatId, userId)
  await deletePendingQuestionByKey(runtime, key, requestId)
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

function parseCallbackData(input: string): { callbackId: string; questionIndex: number; optionIndex: number } | undefined {
  const match = input.match(/^q:([a-z0-9]{6,24}):(\d+):(\d+)$/)
  if (!match) return
  const questionIndex = Number.parseInt(match[2] || "", 10)
  const optionIndex = Number.parseInt(match[3] || "", 10)
  if (!Number.isFinite(questionIndex) || !Number.isFinite(optionIndex)) return
  if (questionIndex < 1 || optionIndex < 1) return
  return {
    callbackId: match[1] || "",
    questionIndex: questionIndex - 1,
    optionIndex: optionIndex - 1,
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

function parsePendingQuestion(properties: Record<string, unknown>): TelegramPendingQuestion | undefined {
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
  const lines = list.map((sessionId, index) => {
    const suffix = current === sessionId ? " (current)" : ""
    return `${index + 1}. ${sessionId}${suffix}`
  })
  return `Known sessions for this chat/user mapping:\n${lines.join("\n")}\n\nUse /switch <index|session-id> to switch.`
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
  const users: Array<{ id: string; text: string }> = []
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
    const text = parseRecentText(row.parts)
    if (!id || !role || !text) continue
    if (role === "assistant" && parentID && !assistants.has(parentID)) {
      assistants.set(parentID, text)
      continue
    }
    if (role !== "user") continue
    users.push({ id, text })
  }
  if (!users.length) {
    return `No recent chat messages found for session ${sessionId}. Send a new message first.`
  }
  const list = users.slice(-safeCount)
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

async function sessionExists(config: BridgeConfig, sessionId: string): Promise<boolean> {
  const id = sessionId.trim()
  if (!id) return false
  const url = opencodeUrl(config, `/session/${encodeURIComponent(id)}`)
  if (config.directory) {
    url.searchParams.set("directory", config.directory)
  }
  const res = await fetch(url, {
    method: "GET",
    signal: AbortSignal.timeout(12_000),
  })
  if (res.ok) return true
  if (res.status === 404) return false
  const body = await res.text().catch(() => "")
  throw new Error(`OpenCode session lookup failed (${res.status}): ${body.slice(0, 300)}`)
}

function resolveSwitchTarget(target: string, list: string[]): { sessionId?: string; error?: string; fromKnownList: boolean } {
  const value = target.trim()
  if (!value) {
    return { error: "Usage: /switch <session-id|index>", fromKnownList: false }
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

export function cacheSession(config: BridgeConfig, chatId: string, sessionId: string) {
  const expiresAt = Date.now() + config.sessionCacheTtlMs
  sessions.delete(chatId)
  sessions.set(chatId, { id: sessionId, expiresAt })
  for (const key of sessions.keys()) {
    if (sessions.size <= config.sessionCacheMax) return
    sessions.delete(key)
  }
}

export function sessionFromCache(config: BridgeConfig, chatId: string): string | undefined {
  const now = Date.now()
  for (const [key, value] of sessions) {
    if (value.expiresAt > now) continue
    sessions.delete(key)
  }

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

  const created = createSession(config)
    .then((id) => {
      return runtime.store.set(chatKey, id).then(() => {
        cacheSession(config, chatKey, id)
        rememberSessionWithoutBlocking(runtime, chatKey, id)
        creatingSessions.delete(chatKey)
        return id
      })
    })
    .catch((error) => {
      creatingSessions.delete(chatKey)
      throw error
    })

  creatingSessions.set(chatKey, created)
  return created
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
  const data = await res.json().catch(() => ({})) as { global?: unknown; project?: unknown }
  return {
    global: parseSavedPromptList(data.global, "global"),
    project: parseSavedPromptList(data.project, "project"),
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

function savedPromptsFailureGuidance(status: number | undefined, directory?: string): string {
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
  const current = await runtime.store.get(key) || sessionFromCache(config, key)
  const bySession = current ? await sessionDirectory(config, current) : undefined
  const candidates = [bySession, config.directory]
    .filter((value): value is string => Boolean(value))
    .filter((value, index, list) => list.indexOf(value) === index)
  const contexts = [...candidates, undefined]
  let fallbackGuidance: string | undefined

  for (const directory of contexts) {
    const scoped = await savedPromptsForDirectory(config, directory).catch((error) => {
      const status = savedPromptsStatus(error)
      fallbackGuidance = savedPromptsFailureGuidance(status, directory)
      return
    })
    if (!scoped) continue
    const merged = mergeSavedPrompts(scoped.global, scoped.project)
    if (merged.length) {
      return { prompts: merged }
    }
  }

  return {
    prompts: [],
    guidance: fallbackGuidance || "No saved prompts found. If your prompts are project-scoped, run /status in the target project first or configure Telegram directory in bridge settings.",
  }
}

function promptScope(scope: SavedPrompt["scope"]): string {
  if (scope === "project") return "project"
  return "global"
}

function promptChoice(prompt: SavedPrompt, index: number): string {
  return `${index + 1}. ${prompt.title} [${promptScope(prompt.scope)}] (${prompt.id})`
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
  const [telegramApi, openCodeApi] = await Promise.all([checkTelegramApi(runtime.config), checkOpenCodeApi(runtime.config)])
  const healthy = telegramApi.status === "ok" && openCodeApi.status === "ok"
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
    const parsed = parseCallbackData(data)
    if (!parsed) {
      await answerCallback(runtime.config, callbackId, "Unsupported button payload.")
      state.acknowledged = true
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
    await sendQuestionReply(runtime.config, pending.requestId, answers)
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
      const sessionId = await sessionForChat(runtime, key)
      await sendTelegramMessage(config, chatId, `Current session: ${sessionId}`)
      return true
    }
    if (known?.name === "new") {
      const next = await createSession(config)
      await runtime.store.set(key, next)
      cacheSession(config, key, next)
      await rememberSession(runtime, key, next)
      await sendTelegramMessage(config, chatId, `Started a new session: ${next}`)
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
      const text = await recentText(config, current, parsed.count || recentDefaultCount)
      await sendTelegramMessage(config, chatId, text)
      return true
    }
    if (known?.name === "switch") {
      const target = command.args.join(" ").trim()
      if (!target) {
        await sendTelegramMessage(config, chatId, "Usage: /switch <session-id|index>")
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
        await sendTelegramMessage(config, chatId, "Usage: /switch <session-id|index>")
        return true
      }
      if (!resolved.fromKnownList && !(await sessionExists(config, next))) {
        await sendTelegramMessage(config, chatId, `Session not found: ${next}. Use /sessions to select a known session or /new to create one.`)
        return true
      }
      await runtime.store.set(key, next)
      cacheSession(config, key, next)
      await rememberSession(runtime, key, next)
      await sendTelegramMessage(config, chatId, `Switched to session: ${next}`)
      return true
    }
    if (known?.name === "notify") {
      const mode = command.args[0]?.toLowerCase() || ""
      const notifyKey = notificationKey(chatId)
      if (mode === "on") {
        await setNotificationEnabled(runtime, notifyKey, true)
        await sendTelegramMessage(config, chatId, "Notifications enabled for this chat.")
        return true
      }
      if (mode === "off") {
        await setNotificationEnabled(runtime, notifyKey, false)
        await sendTelegramMessage(config, chatId, "Notifications disabled for this chat.")
        return true
      }
      if (mode === "status" || !mode) {
        const enabled = await notificationEnabled(runtime, notifyKey)
        await sendTelegramMessage(config, chatId, enabled ? "Notifications are enabled." : "Notifications are disabled.")
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
      await sendTelegramMessage(config, chatId, promptsListText(list.prompts, list.guidance))
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
      const sessionId = await sessionForChat(runtime, key)
      await resolvePendingForSession(runtime, chatId, sessionId)
      const reply = await sendPrompt(config, sessionId, selected.text).catch(async (error) => {
        if (!isMissingSession(error)) {
          throw error
        }
        sessions.delete(key)
        await runtime.store.delete(key)
        const next = await sessionForChat(runtime, key)
        return sendPrompt(config, next, selected.text)
      })
      await sendTelegramMessage(config, chatId, reply)
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

    const queuedQuestions = await readPendingQuestions(runtime, chatId, userId)
    const pending = queuedQuestions[0]
    if (pending) {
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
        const keyForPending = pendingKey(chatId, userId)
        await upsertPendingQuestion(runtime, keyForPending, withAnswers(pending, answers))
        const queue = await readPendingQuestions(runtime, chatId, userId)
        const next = queue.find((item) => item.requestId === pending.requestId)
        if (!next) {
          await sendTelegramMessage(config, chatId, "That question is no longer pending. Wait for the next prompt or use /status.")
          return
        }
        await sendTelegramMessage(config, chatId, "Thanks, answer recorded.")
        await sendTelegramQuestionPrompt(config, chatId, next)
        return
      }
      await sendQuestionReply(config, pending.requestId, answers)
        .then(async () => {
          await deletePendingQuestion(runtime, chatId, pending.requestId, userId)
          const remaining = await readPendingQuestions(runtime, chatId, userId)
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
          await deletePendingQuestion(runtime, chatId, pending.requestId, userId)
          await sendTelegramMessage(config, chatId, "That question is no longer pending. Wait for the next prompt or use /status.")
        })
      return
    }

    const sessionId = await sessionForChat(runtime, key)
    await resolvePendingForSession(runtime, chatId, sessionId)
    const reply = await sendPrompt(config, sessionId, text).catch(async (error) => {
      if (!isMissingSession(error)) {
        throw error
      }
      sessions.delete(key)
      await runtime.store.delete(key)
      const next = await sessionForChat(runtime, key)
      return sendPrompt(config, next, text)
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
  kind: "question" | "permission" | "task-finished",
  text: string,
  requestId?: string,
  notifyKind?: string,
) {
  if (!runtime.store.sessionKeys) return
  const dedupeKey = notifyKind || kind
  const keys = await runtime.store.sessionKeys(sessionId)
  const chats = new Set<number>()
  for (const mapKey of keys) {
    try {
      const parsed = parseTelegramKey(mapKey)
      if (!parsed) continue
      if (!chats.has(parsed.chatId)) {
        chats.add(parsed.chatId)
        const entry: TelegramPendingItem = {
          id: pendingEntryId(sessionId, kind, parsed.chatId, requestId),
          kind,
          sessionId,
          text,
          stampedAt: Date.now(),
          resolved: kind === "task-finished",
        }
        await appendPending(runtime, parsed.chatId, entry)
        if (kind === "task-finished") {
          await resolvePendingForSession(runtime, parsed.chatId, sessionId)
        }
      }
      if (!(await notificationEnabled(runtime, notificationKey(parsed.chatId)))) continue
      if (!proactiveTelegramEnabled(runtime.config)) continue
      if (!shouldNotify(runtime.config, parsed.chatId, dedupeKey, sessionId)) continue
      const message = `${text}\n\nOpen ${sessionLabel(runtime.config, sessionId)}`
      await queueChatUpdate(String(parsed.chatId), async () => {
        await sendTelegramMessage(runtime.config, parsed.chatId, message)
      })
      stampNotification(parsed.chatId, dedupeKey, sessionId)
    } catch (error) {
      console.error("[TelegramBridge] outbound notify failed", { sessionId, key: mapKey, kind, error })
    }
  }
}

async function notifyQuestion(runtime: Runtime, sessionId: string, question: TelegramPendingQuestion) {
  if (!runtime.store.sessionKeys) return
  const keys = await runtime.store.sessionKeys(sessionId)
  const kind = `question:${question.requestId}`
  const chats = new Set<number>()
  for (const key of keys) {
    try {
      const parsed = parseTelegramKey(key)
      if (!parsed) continue
      await upsertPendingQuestion(runtime, key, question)
      if (!chats.has(parsed.chatId)) {
        chats.add(parsed.chatId)
        await appendPending(runtime, parsed.chatId, {
          id: pendingEntryId(sessionId, "question", parsed.chatId, question.requestId),
          kind: "question",
          sessionId,
          text: pendingQuestionText(question),
          stampedAt: Date.now(),
          resolved: false,
        })
      }
      if (!(await notificationEnabled(runtime, notificationKey(parsed.chatId)))) continue
      if (!proactiveTelegramEnabled(runtime.config)) continue
      if (!shouldNotify(runtime.config, parsed.chatId, kind, sessionId)) continue
      await queueChatUpdate(String(parsed.chatId), async () => {
        await sendTelegramQuestionPrompt(runtime.config, parsed.chatId, question)
        await sendTelegramMessage(runtime.config, parsed.chatId, `Open ${sessionLabel(runtime.config, sessionId)}`)
      })
      stampNotification(parsed.chatId, kind, sessionId)
    } catch (error) {
      console.error("[TelegramBridge] outbound question notify failed", { sessionId, key, error })
    }
  }
}

async function handleOutboundBlocks(runtime: Runtime, blocks: string[]) {
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
    await handleBridgeEvent(runtime, event)
  }
}

export async function consumeOutboundEventStream(runtime: Runtime, body: ReadableStream<Uint8Array>) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const parser = createOutboundSSEParser()
  while (true) {
    const step = await reader.read()
    if (step.done) break
    const blocks = parser.push(decoder.decode(step.value, { stream: true }))
    await handleOutboundBlocks(runtime, blocks)
  }

  const finalText = decoder.decode()
  if (finalText) {
    await handleOutboundBlocks(runtime, parser.push(finalText))
  }

  const tailBlocks = parser.flush()
  await handleOutboundBlocks(runtime, tailBlocks)
}

export async function handleBridgeEvent(runtime: Runtime, event: { type: string; properties: Record<string, unknown> }) {
  const sessionId = typeof event.properties.sessionID === "string" ? event.properties.sessionID : ""
  if (event.type === "session.deleted") {
    const info = event.properties.info && typeof event.properties.info === "object"
      ? event.properties.info as { id?: unknown }
      : undefined
    const deletedSessionId = typeof info?.id === "string" ? info.id : sessionId
    if (!deletedSessionId) return
    statusBySession.delete(deletedSessionId)
    if (runtime.store.sessionKeys) {
      const keys = await runtime.store.sessionKeys(deletedSessionId)
      const chats = new Set<number>()
      for (const key of keys) {
        const parsed = parseTelegramKey(key)
        if (!parsed) continue
        if (chats.has(parsed.chatId)) continue
        chats.add(parsed.chatId)
        await resolvePendingForSession(runtime, parsed.chatId, deletedSessionId)
      }
    }
    return
  }
  if (!sessionId) return
  if (event.type === "question.asked") {
    const pending = parsePendingQuestion(event.properties)
    if (!pending) {
      const requestId = typeof event.properties.id === "string" ? event.properties.id.trim() : ""
      const notifyKind = requestId ? `question:${requestId}` : undefined
      await notifySessionKeys(
        runtime,
        sessionId,
        "question",
        `Question pending: ${questionText(event.properties)}`,
        requestId || undefined,
        notifyKind,
      )
      return
    }
    await notifyQuestion(runtime, sessionId, pending)
    return
  }
  if (event.type === "permission.asked") {
    const requestId = typeof event.properties.id === "string" ? event.properties.id.trim() : ""
    const notifyKind = requestId ? `permission:${requestId}` : undefined
    await notifySessionKeys(runtime, sessionId, "permission", permissionText(event.properties), requestId || undefined, notifyKind)
    return
  }
  if (event.type !== "session.status") return
  const status = event.properties.status && typeof event.properties.status === "object"
    ? event.properties.status as { type?: unknown }
    : undefined
  const next = typeof status?.type === "string" ? status.type : ""
  const prev = statusBySession.get(sessionId)
  if (next !== "idle") {
    statusBySession.set(sessionId, next)
    return
  }
  statusBySession.delete(sessionId)
  if (!prev || prev === "idle") return
  await notifySessionKeys(runtime, sessionId, "task-finished", "Task finished: the session is now idle.")
}

async function runOutboundNotifications(runtime: Runtime) {
  const config = runtime.config
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

      await consumeOutboundEventStream(runtime, response.body)
    } catch (error) {
      if (isTimeoutError(error)) {
        console.log("[TelegramBridge] outbound event stream timed out, reconnecting")
        await sleep(1500)
        continue
      }
      console.error("[TelegramBridge] outbound event stream error", error)
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
  const runtime = { config, store }
  console.log(`[TelegramBridge] OpenCode API: ${config.openCodeUrl}`)
  console.log(`[TelegramBridge] Session store: ${config.sessionStorePath}`)
  if (config.directory) {
    console.log(`[TelegramBridge] OpenCode directory: ${config.directory}`)
  }
  registerTelegramCommandsWithoutBlocking(config)
  if (config.mode === "polling") {
    runPollingHealthServer(runtime)
    await Promise.all([runPolling(runtime), runOutboundNotifications(runtime)])
    return
  }

  await Promise.all([runWebhook(runtime), runOutboundNotifications(runtime)])
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
}
