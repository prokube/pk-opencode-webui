import { mkdir, rename } from "node:fs/promises"
import { dirname } from "node:path"

type StoreShape = {
  version: 1
  sessions: Record<string, string>
}

function emptyStore(): StoreShape {
  return {
    version: 1,
    sessions: {},
  }
}

function parseStore(input: string): StoreShape {
  if (!input.trim()) return emptyStore()
  const data = JSON.parse(input) as Partial<StoreShape>
  const sessions = data.sessions && typeof data.sessions === "object" ? data.sessions : {}
  const out: Record<string, string> = {}
  for (const key of Object.keys(sessions)) {
    const value = sessions[key]
    if (typeof value !== "string" || !value) continue
    out[key] = value
  }
  return {
    version: 1,
    sessions: out,
  }
}

async function readStore(path: string): Promise<StoreShape> {
  const file = Bun.file(path)
  const exists = await file.exists()
  if (!exists) return emptyStore()
  const text = await file.text()
  return parseStore(text)
}

async function writeStore(path: string, data: StoreShape) {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.tmp`
  const body = `${JSON.stringify(data, null, 2)}\n`
  await Bun.write(temp, body)
  await rename(temp, path)
}

export type TelegramSessionStore = {
  get: (key: string) => Promise<string | undefined>
  set: (key: string, sessionId: string) => Promise<void>
  delete: (key: string) => Promise<void>
}

export function createTelegramSessionStore(path: string): TelegramSessionStore {
  const sessions = new Map<string, string>()
  const ready = readStore(path)
    .then((data) => {
      for (const [key, value] of Object.entries(data.sessions)) {
        sessions.set(key, value)
      }
    })
    .catch((error) => {
      console.warn("[TelegramBridge] session store load failed, starting empty", { path, error })
    })

  let writes = Promise.resolve()

  function flush() {
    const payload: StoreShape = {
      version: 1,
      sessions: Object.fromEntries(sessions),
    }
    writes = writes.then(
      () => writeStore(path, payload),
      () => writeStore(path, payload),
    )
    return writes.catch((error) => {
      console.error("[TelegramBridge] session store write failed", { path, error })
    })
  }

  return {
    async get(key: string) {
      await ready
      return sessions.get(key)
    },
    async set(key: string, sessionId: string) {
      await ready
      if (sessions.get(key) === sessionId) return
      sessions.set(key, sessionId)
      await flush()
    },
    async delete(key: string) {
      await ready
      const removed = sessions.delete(key)
      if (!removed) return
      await flush()
    },
  }
}

export function telegramSessionKey(chatId: number, userId?: number): string {
  if (!userId) return `chat:${chatId}`
  return `chat:${chatId}:user:${userId}`
}
