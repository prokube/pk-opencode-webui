import { mkdir, readdir, rename, rm } from "node:fs/promises"
import { basename, dirname, join } from "node:path"

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
  if (exists) {
    const text = await file.text()
    return parseStore(text)
  }

  const dir = dirname(path)
  const name = basename(path)
  const entries = await readdir(dir).catch((error) => {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : ""
    if (code === "ENOENT" || code === "ENOTDIR") return []
    throw error
  })
  const backups = entries
    .filter((entry) => entry.startsWith(`${name}.bak.`))
    .sort((a, b) => {
      const aStamp = Number(a.slice(`${name}.bak.`.length).split(".")[0] || "0")
      const bStamp = Number(b.slice(`${name}.bak.`.length).split(".")[0] || "0")
      return bStamp - aStamp
    })

  for (const entry of backups) {
    const backupPath = join(dir, entry)
    const text = await Bun.file(backupPath)
      .text()
      .catch(() => "")
    if (!text) continue
    const data = await Promise.resolve()
      .then(() => parseStore(text))
      .catch(() => undefined)
    if (!data) continue

    await rename(backupPath, path).catch((error) => {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : ""
      if (code === "EEXIST" || code === "EPERM" || code === "ENOTEMPTY") return
      throw error
    })
    return data
  }

  return emptyStore()
}

async function writeStore(path: string, data: StoreShape) {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.tmp`
  const backup = `${path}.bak.${Date.now()}.${Math.random().toString(36).slice(2)}`
  const body = `${JSON.stringify(data, null, 2)}\n`
  await Bun.write(temp, body)
  const replace = rename(temp, path).catch(async (error) => {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : ""
    if (code !== "EEXIST" && code !== "EPERM" && code !== "ENOTEMPTY" && code !== "EACCES") {
      await rm(temp, { force: true }).catch(() => undefined)
      throw error
    }
    await rename(path, backup)
    await rename(temp, path).catch(async (renameError) => {
      await rename(backup, path).catch(() => undefined)
      await rm(temp, { force: true }).catch(() => undefined)
      throw renameError
    })
    await rm(backup, { force: true }).catch(() => undefined)
  })
  await replace.catch(async (error) => {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  })
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
  let ops = Promise.resolve()

  function flush() {
    const payload: StoreShape = {
      version: 1,
      sessions: Object.fromEntries(sessions),
    }
    writes = writes.then(
      () => writeStore(path, payload),
      () => writeStore(path, payload),
    )
    return writes
  }

  function run(task: () => Promise<void>) {
    const step = ops.then(task, task)
    ops = step.catch(() => undefined)
    return step
  }

  return {
    async get(key: string) {
      await ready
      return sessions.get(key)
    },
    async set(key: string, sessionId: string) {
      await ready
      await run(async () => {
        const prev = sessions.get(key)
        if (prev === sessionId) return
        sessions.set(key, sessionId)
        await flush().catch((error) => {
          if (prev !== undefined) {
            sessions.set(key, prev)
            throw error
          }
          sessions.delete(key)
          throw error
        })
      })
    },
    async delete(key: string) {
      await ready
      await run(async () => {
        const prev = sessions.get(key)
        if (prev === undefined) return
        sessions.delete(key)
        await flush().catch((error) => {
          sessions.set(key, prev)
          throw error
        })
      })
    },
  }
}

export function telegramSessionKey(chatId: number, userId?: number): string {
  if (!userId) return `chat:${chatId}`
  return `chat:${chatId}:user:${userId}`
}
