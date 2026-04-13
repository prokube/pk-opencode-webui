import { createTelegramSessionStore, telegramSessionKey } from "./telegram-session-store"
import { tmpdir } from "node:os"
import { join } from "node:path"

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

type CachedSession = {
  id: string
  expiresAt: number
}

const sessions = new Map<string, CachedSession>()
const creatingSessions = new Map<string, Promise<string>>()
const chatQueues = new Map<string, Promise<void>>()
const eventNotifications = new Map<string, number>()
const statusBySession = new Map<string, string>()
const fallbackNotifications = new Map<string, boolean>()

function env(name: string): string {
  return process.env[name]?.trim() || ""
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

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

function parsePort(value: string): number {
  const n = Number.parseInt(value, 10)
  if (Number.isNaN(n) || n <= 0 || n > 65535) return 4097
  return n
}

function parsePositiveInt(value: string, fallback: number): number {
  const n = Number.parseInt(value, 10)
  if (Number.isNaN(n) || n <= 0) return fallback
  return n
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
  return [
    "Available commands:",
    "/new - start and switch to a fresh OpenCode session",
    "/status - show current session mapping",
    "/notify on|off|status - control proactive notifications for this chat",
    "/help - show this help message",
  ].join("\n")
}

function normalizeLinkBase(value: string): string | undefined {
  if (!value) return
  const trimmed = value.trim()
  if (!trimmed) return
  const base = trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed
  try {
    return new URL(base).toString().replace(/\/$/, "")
  } catch {
    throw new Error(`Invalid TELEGRAM_SESSION_LINK_BASE URL: ${value}`)
  }
}

function parseTelegramKey(key: string): { chatId: number } | undefined {
  const parts = key.split(":")
  if (parts.length < 2) return
  if (parts[0] !== "chat") return
  const chatId = Number.parseInt(parts[1] || "", 10)
  if (!Number.isFinite(chatId)) return
  return { chatId }
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

function sessionLabel(config: BridgeConfig, sessionId: string): string {
  if (!config.sessionLinkBase) return `session ${sessionId}`
  return `${config.sessionLinkBase}/session/${encodeURIComponent(sessionId)}`
}

function notificationKey(chatId: number): string {
  return telegramSessionKey(chatId)
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

function permissionText(properties: Record<string, unknown>): string {
  const permission = typeof properties.permission === "string" ? properties.permission : "permission"
  const patterns = Array.isArray(properties.patterns)
    ? properties.patterns.filter((part) => typeof part === "string" && part).slice(0, 3)
    : []
  if (!patterns.length) return `Permission request: ${permission}`
  return `Permission request: ${permission} (${patterns.join(", ")})`
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

function parseOpenCodeUrl(value: string, source: string): string {
  try {
    const url = new URL(value)
    return url.toString()
  } catch {
    throw new Error(`Invalid OpenCode API URL from ${source}: ${value}`)
  }
}

function defaultSessionStorePath() {
  return join(tmpdir(), "opencode-telegram-sessions.json")
}

export function parseConfig(): BridgeConfig {
  const token = env("TELEGRAM_BOT_TOKEN")
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is required")
  }

  const mode = parseMode(env("TELEGRAM_MODE") || "polling")
  const opencodeApiUrl = env("OPENCODE_API_URL")
  const apiUrl = env("API_URL")
  const openCodeUrlValue = opencodeApiUrl || apiUrl || "http://127.0.0.1:4096"
  const openCodeUrlSource = opencodeApiUrl ? "OPENCODE_API_URL" : apiUrl ? "API_URL" : "default"
  const openCodeUrl = parseOpenCodeUrl(openCodeUrlValue, openCodeUrlSource)
  const webhookPath = env("TELEGRAM_WEBHOOK_PATH") || "/webhook"
  const sessionCacheMax = parsePositiveInt(env("TELEGRAM_SESSION_CACHE_MAX") || "", 500)
  const sessionCacheTtlMs = parsePositiveInt(env("TELEGRAM_SESSION_CACHE_TTL_MS") || "", 6 * 60 * 60 * 1000)
  const notificationDebounceMs = parsePositiveInt(env("TELEGRAM_NOTIFY_DEBOUNCE_MS") || "", 20_000)
  const sessionStorePath = env("TELEGRAM_SESSION_STORE_PATH") || defaultSessionStorePath()
  const sessionLinkBase = normalizeLinkBase(env("TELEGRAM_SESSION_LINK_BASE"))

  return {
    mode,
    token,
    openCodeUrl,
    sessionLinkBase,
    directory: env("OPENCODE_DIRECTORY") || undefined,
    sessionCacheMax,
    sessionCacheTtlMs,
    notificationDebounceMs,
    port: parsePort(env("TELEGRAM_BRIDGE_PORT") || "4097"),
    webhookPath: webhookPath.startsWith("/") ? webhookPath : `/${webhookPath}`,
    webhookSecret: env("TELEGRAM_WEBHOOK_SECRET") || undefined,
    webhookUrl: env("TELEGRAM_WEBHOOK_URL") || undefined,
    sessionStorePath,
  }
}

function isMissingSession(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.message.startsWith("OpenCode prompt failed (404):")) return true
  if (error.message.startsWith("OpenCode prompt failed (410):")) return true
  return false
}

async function retry<T>(name: string, fn: () => Promise<T>, retries = 2, delayMs = 400): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    if (retries <= 0) throw error
    console.warn(`[TelegramBridge] ${name} failed, retrying in ${delayMs}ms`, error)
    await sleep(delayMs)
    return retry(name, fn, retries - 1, Math.min(delayMs * 2, 4000))
  }
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
  }

  const cached = sessionFromCache(config, chatKey)
  if (cached) return cached

  const creating = creatingSessions.get(chatKey)
  if (creating) return creating

  const created = createSession(config)
    .then((id) => {
      return runtime.store.set(chatKey, id).then(() => {
        cacheSession(config, chatKey, id)
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
  for (const part of chunks(safe, 3900)) {
    await telegramRequest(config, "sendMessage", {
      chat_id: chatId,
      text: part,
    })
  }
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
    if (command.name === "/help") {
      await sendTelegramMessage(config, chatId, helpText())
      return true
    }
    if (command.name === "/status") {
      const sessionId = await sessionForChat(runtime, key)
      await sendTelegramMessage(config, chatId, `Current session: ${sessionId}`)
      return true
    }
    if (command.name === "/new") {
      const next = await createSession(config)
      await runtime.store.set(key, next)
      cacheSession(config, key, next)
      await sendTelegramMessage(config, chatId, `Started a new session: ${next}`)
      return true
    }
    if (command.name === "/notify") {
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
    await sendTelegramMessage(config, chatId, `Unknown command ${command.name}. Use /help.`)
    return true
  }

  try {
    const handled = await runCommand()
    if (handled) return

    const sessionId = await sessionForChat(runtime, key)
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

async function notifySessionKeys(runtime: Runtime, sessionId: string, kind: string, text: string) {
  if (!runtime.store.sessionKeys) return
  const keys = await runtime.store.sessionKeys(sessionId)
  for (const key of keys) {
    try {
      const parsed = parseTelegramKey(key)
      if (!parsed) continue
      if (!(await notificationEnabled(runtime, notificationKey(parsed.chatId)))) continue
      if (!shouldNotify(runtime.config, parsed.chatId, kind, sessionId)) continue
      const message = `${text}\n\nOpen ${sessionLabel(runtime.config, sessionId)}`
      await queueChatUpdate(String(parsed.chatId), async () => {
        await sendTelegramMessage(runtime.config, parsed.chatId, message)
      })
      stampNotification(parsed.chatId, kind, sessionId)
    } catch (error) {
      console.error("[TelegramBridge] outbound notify failed", { sessionId, key, kind, error })
    }
  }
}

export async function handleBridgeEvent(runtime: Runtime, event: { type: string; properties: Record<string, unknown> }) {
  const sessionId = typeof event.properties.sessionID === "string" ? event.properties.sessionID : ""
  if (!sessionId) return
  if (event.type === "question.asked") {
    await notifySessionKeys(runtime, sessionId, "question", `Question pending: ${questionText(event.properties)}`)
    return
  }
  if (event.type === "permission.asked") {
    await notifySessionKeys(runtime, sessionId, "permission", permissionText(event.properties))
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

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      while (true) {
        const step = await reader.read()
        if (step.done) break
        buffer += decoder.decode(step.value, { stream: true }).replace(/\r\n/g, "\n")
        while (true) {
          const boundary = buffer.indexOf("\n\n")
          if (boundary === -1) break
          const block = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
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
    } catch (error) {
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
          allowed_updates: ["message"],
        },
        35_000,
      )) as TelegramUpdate[]

      const runs: Promise<void>[] = []
      for (const update of result || []) {
        offset = Math.max(offset, update.update_id + 1)
        const chatId = update.message?.chat?.id
        const run = !chatId
          ? handleTextUpdate(runtime, update)
          : queueChatUpdate(String(chatId), () => handleTextUpdate(runtime, update))
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

async function runWebhook(runtime: Runtime) {
  const config = runtime.config
  if (config.webhookUrl) {
    await telegramRequest(config, "setWebhook", {
      url: config.webhookUrl,
      secret_token: config.webhookSecret,
      allowed_updates: ["message"],
    })
    console.log(`[TelegramBridge] webhook registered: ${config.webhookUrl}`)
  }

  Bun.serve({
    port: config.port,
    hostname: "0.0.0.0",
    async fetch(req) {
      const url = new URL(req.url)
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

      const chatId = update.message?.chat?.id
      const run = !chatId
        ? handleTextUpdate(runtime, update)
        : queueChatUpdate(String(chatId), () => handleTextUpdate(runtime, update))
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
  const store = createTelegramSessionStore(config.sessionStorePath)
  const runtime = { config, store }
  console.log(`[TelegramBridge] OpenCode API: ${config.openCodeUrl}`)
  console.log(`[TelegramBridge] Session store: ${config.sessionStorePath}`)
  if (config.directory) {
    console.log(`[TelegramBridge] OpenCode directory: ${config.directory}`)
  }
  if (config.mode === "polling") {
    await Promise.all([runPolling(runtime), runOutboundNotifications(runtime)])
    return
  }

  await Promise.all([runWebhook(runtime), runOutboundNotifications(runtime)])
}

export function resetSessionCacheForTest() {
  sessions.clear()
  creatingSessions.clear()
  chatQueues.clear()
  eventNotifications.clear()
  statusBySession.clear()
  fallbackNotifications.clear()
}
