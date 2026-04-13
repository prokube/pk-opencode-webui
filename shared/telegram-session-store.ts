import { mkdir, readdir, rename, rm } from "node:fs/promises"
import { basename, dirname, join } from "node:path"

type StoreShape = {
  version: 2
  sessions: Record<string, string>
  notifications: Record<string, boolean>
}

function emptyStore(): StoreShape {
  return {
    version: 2,
    sessions: {},
    notifications: {},
  }
}

function parseStore(input: string): StoreShape {
  if (!input.trim()) return emptyStore()
  const data = JSON.parse(input) as Partial<StoreShape>
  const sessions = data.sessions && typeof data.sessions === "object" ? data.sessions : {}
  const notifications = data.notifications && typeof data.notifications === "object" ? data.notifications : {}
  const out: Record<string, string> = {}
  const notifyOut: Record<string, boolean> = {}
  for (const key of Object.keys(sessions)) {
    const value = sessions[key]
    if (typeof value !== "string" || !value) continue
    out[key] = value
  }
  for (const key of Object.keys(notifications)) {
    const value = notifications[key]
    if (typeof value !== "boolean") continue
    notifyOut[key] = value
  }
  return {
    version: 2,
    sessions: out,
    notifications: notifyOut,
  }
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error ? String(error.code) : ""
}

function isReplaceConflict(code: string): boolean {
  return code === "EEXIST" || code === "EPERM" || code === "ENOTEMPTY" || code === "EACCES"
}

async function applyBackupStore(path: string, backupPath: string): Promise<boolean> {
  const direct = await rename(backupPath, path).then(
    () => true,
    (error) => {
      if (isReplaceConflict(errorCode(error))) return false
      throw error
    },
  )
  if (direct) return true

  const displaced = `${path}.corrupt.${Date.now()}.${Math.random().toString(36).slice(2)}`
  const moved = await rename(path, displaced).then(
    () => true,
    (error) => {
      const code = errorCode(error)
      if (code === "ENOENT") return false
      if (isReplaceConflict(code)) return
      throw error
    },
  )
  if (moved === undefined) return false

  const applied = await rename(backupPath, path).then(
    () => true,
    async (error) => {
      if (moved) {
        await rename(displaced, path).catch(() => undefined)
      }
      const code = errorCode(error)
      if (isReplaceConflict(code) || code === "ENOENT") return false
      throw error
    },
  )
  if (!applied) return false
  if (moved) {
    await rm(displaced, { force: true }).catch(() => undefined)
  }
  return true
}

async function readBackupStore(path: string): Promise<StoreShape | undefined> {
  const dir = dirname(path)
  const name = basename(path)
  const entries = await readdir(dir).catch((error) => {
    const code = errorCode(error)
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

    const applied = await applyBackupStore(path, backupPath)
    if (!applied) continue
    return data
  }

  return
}

async function readStore(path: string): Promise<StoreShape> {
  const file = Bun.file(path)
  const exists = await file.exists()
  if (exists) {
    const text = await file.text()
    const data = await Promise.resolve()
      .then(() => parseStore(text))
      .catch(() => undefined)
    if (data) return data
  }

  const recovered = await readBackupStore(path)
  if (recovered) return recovered

  return emptyStore()
}

async function writeStore(path: string, data: StoreShape) {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.tmp`
  const backup = `${path}.bak.${Date.now()}.${Math.random().toString(36).slice(2)}`
  const body = `${JSON.stringify(data, null, 2)}\n`
  await Bun.write(temp, body)
  const replace = rename(temp, path).catch(async (error) => {
    const code = errorCode(error)
    if (!isReplaceConflict(code)) {
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
  sessionKeys?: (sessionId: string) => Promise<string[]>
  notificationGet?: (key: string) => Promise<boolean>
  notificationSet?: (key: string, enabled: boolean) => Promise<void>
}

export function createTelegramSessionStore(path: string): TelegramSessionStore {
  // In-memory serialization only coordinates writes within this process.
  // Cross-process writers need an external coordinated store.
  const sessions = new Map<string, string>()
  const notifications = new Map<string, boolean>()
  const ready = readStore(path)
    .then((data) => {
      for (const [key, value] of Object.entries(data.sessions)) {
        sessions.set(key, value)
      }
      for (const [key, value] of Object.entries(data.notifications)) {
        notifications.set(key, value)
      }
    })
    .catch((error) => {
      console.warn("[TelegramBridge] session store load failed, starting empty", { path, error })
    })

  let writes = Promise.resolve()
  let ops = Promise.resolve()

  function flush() {
    const payload: StoreShape = {
      version: 2,
      sessions: Object.fromEntries(sessions),
      notifications: Object.fromEntries(notifications),
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
    async sessionKeys(sessionId: string) {
      await ready
      const keys: string[] = []
      for (const [key, value] of sessions) {
        if (value === sessionId) {
          keys.push(key)
        }
      }
      return keys
    },
    async notificationGet(key: string) {
      await ready
      return notifications.get(key) === true
    },
    async notificationSet(key: string, enabled: boolean) {
      await ready
      await run(async () => {
        const prev = notifications.get(key)
        if (enabled) notifications.set(key, true)
        if (!enabled) notifications.delete(key)
        await flush().catch((error) => {
          if (prev === undefined) {
            notifications.delete(key)
            throw error
          }
          notifications.set(key, prev)
          throw error
        })
      })
    },
  }
}

export function telegramSessionKey(chatId: number, userId?: number): string {
  if (userId === undefined || userId === null) return `chat:${chatId}`
  return `chat:${chatId}:user:${userId}`
}
