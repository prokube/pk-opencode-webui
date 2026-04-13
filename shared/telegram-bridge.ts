import { createTelegramSessionStore, telegramSessionKey } from "./telegram-session-store"

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
  directory?: string
  sessionCacheMax: number
  sessionCacheTtlMs: number
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

function parseCommand(text: string): { name: string } | undefined {
  if (!text.startsWith("/")) return
  const raw = text.split(/\s+/, 1)[0]?.trim()
  const name = raw?.split("@")[0]?.trim().toLowerCase()
  if (!name) return
  return { name }
}

function helpText(): string {
  return [
    "Available commands:",
    "/new - start and switch to a fresh OpenCode session",
    "/status - show current session mapping",
    "/help - show this help message",
  ].join("\n")
}

function parseOpenCodeUrl(value: string, source: string): string {
  try {
    const url = new URL(value)
    return url.toString()
  } catch {
    throw new Error(`Invalid OpenCode API URL from ${source}: ${value}`)
  }
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
  const sessionStorePath = env("TELEGRAM_SESSION_STORE_PATH") || "/tmp/opencode-telegram-sessions.json"

  return {
    mode,
    token,
    openCodeUrl,
    directory: env("OPENCODE_DIRECTORY") || undefined,
    sessionCacheMax,
    sessionCacheTtlMs,
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
      cacheSession(config, chatKey, id)
      return runtime.store.set(chatKey, id).then(() => {
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
      cacheSession(config, key, next)
      await runtime.store.set(key, next)
      await sendTelegramMessage(config, chatId, `Started a new session: ${next}`)
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
    await runPolling(runtime)
    return
  }

  await runWebhook(runtime)
}

export function resetSessionCacheForTest() {
  sessions.clear()
  creatingSessions.clear()
  chatQueues.clear()
}
