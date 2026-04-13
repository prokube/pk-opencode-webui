type TelegramUpdate = {
  update_id: number
  message?: {
    message_id: number
    text?: string
    chat?: {
      id: number
    }
  }
}

type BridgeConfig = {
  mode: "polling" | "webhook"
  token: string
  openCodeUrl: string
  directory?: string
  port: number
  webhookPath: string
  webhookSecret?: string
  webhookUrl?: string
}

const sessions = new Map<string, string>()

function env(name: string): string {
  return process.env[name]?.trim() || ""
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parseMode(value: string): "polling" | "webhook" {
  if (value.toLowerCase() === "webhook") return "webhook"
  return "polling"
}

function parsePort(value: string): number {
  const n = Number.parseInt(value, 10)
  if (Number.isNaN(n) || n <= 0) return 4097
  return n
}

function parseConfig(): BridgeConfig {
  const token = env("TELEGRAM_BOT_TOKEN")
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is required")
  }

  const mode = parseMode(env("TELEGRAM_MODE") || "polling")
  const openCodeUrl = env("OPENCODE_API_URL") || env("API_URL") || "http://127.0.0.1:4096"
  const webhookPath = env("TELEGRAM_WEBHOOK_PATH") || "/webhook"

  return {
    mode,
    token,
    openCodeUrl,
    directory: env("OPENCODE_DIRECTORY") || undefined,
    port: parsePort(env("TELEGRAM_BRIDGE_PORT") || "4097"),
    webhookPath: webhookPath.startsWith("/") ? webhookPath : `/${webhookPath}`,
    webhookSecret: env("TELEGRAM_WEBHOOK_SECRET") || undefined,
    webhookUrl: env("TELEGRAM_WEBHOOK_URL") || undefined,
  }
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

function opencodeUrl(config: BridgeConfig, path: string): URL {
  return new URL(path, config.openCodeUrl.endsWith("/") ? config.openCodeUrl : `${config.openCodeUrl}/`)
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

async function sessionForChat(config: BridgeConfig, chatId: string): Promise<string> {
  const cached = sessions.get(chatId)
  if (cached) return cached

  const id = await createSession(config)
  sessions.set(chatId, id)
  return id
}

function extractReply(payload: unknown): string {
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

async function sendPrompt(config: BridgeConfig, sessionID: string, text: string): Promise<string> {
  const url = opencodeUrl(config, `/session/${sessionID}/message`)
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
  for (const i of Array.from({ length: Math.ceil(input.length / size) }, (_, idx) => idx)) {
    output.push(input.slice(i * size, (i + 1) * size))
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

async function handleTextUpdate(config: BridgeConfig, update: TelegramUpdate) {
  const message = update.message
  const chatId = message?.chat?.id
  const text = message?.text?.trim()

  if (!chatId || !text) return

  try {
    const sessionID = await sessionForChat(config, String(chatId))
    const reply = await sendPrompt(config, sessionID, text)
    await sendTelegramMessage(config, chatId, reply)
  } catch (error) {
    console.error("[TelegramBridge] request handling failed", { chatId, error })
    await sendTelegramMessage(config, chatId, "Sorry, I ran into an internal error. Please try again in a moment.")
  }
}

async function runPolling(config: BridgeConfig) {
  console.log("[TelegramBridge] mode=polling")
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

      for (const update of result || []) {
        offset = Math.max(offset, update.update_id + 1)
        await handleTextUpdate(config, update)
      }
    } catch (error) {
      console.error("[TelegramBridge] polling error", error)
      await sleep(1500)
    }
  }
}

async function runWebhook(config: BridgeConfig) {
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

      await handleTextUpdate(config, update)
      return Response.json({ ok: true })
    },
  })

  console.log(`[TelegramBridge] mode=webhook port=${config.port} path=${config.webhookPath}`)
}

export async function startTelegramBridge() {
  const config = parseConfig()
  console.log(`[TelegramBridge] OpenCode API: ${config.openCodeUrl}`)
  if (config.directory) {
    console.log(`[TelegramBridge] OpenCode directory: ${config.directory}`)
  }
  if (config.mode === "polling") {
    await runPolling(config)
    return
  }

  await runWebhook(config)
}
