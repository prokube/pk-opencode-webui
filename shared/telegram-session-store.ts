import { mkdir, readdir, rename, rm } from "node:fs/promises"
import { basename, dirname, join } from "node:path"

type StoreShape = {
  version: 3
  sessions: Record<string, string>
  history: Record<string, string[]>
  notifications: Record<string, boolean>
  pending: Record<string, TelegramPendingQuestion[]>
}

type TelegramPendingQuestionEntry = {
  header: string
  question: string
  options: string[]
  multiple: boolean
  custom: boolean
}

export type TelegramPendingQuestion = {
  requestId: string
  sessionId: string
  createdAt: number
  expiresAt: number
  questions: TelegramPendingQuestionEntry[]
}

function emptyStore(): StoreShape {
  return {
    version: 3,
    sessions: {},
    history: {},
    notifications: {},
    pending: {},
  }
}

function parseHistoryList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value
    .filter((item) => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean))]
}

function parsePendingQuestionEntry(value: unknown): TelegramPendingQuestionEntry | undefined {
  if (!value || typeof value !== "object") return
  const row = value as Record<string, unknown>
  const header = typeof row.header === "string" ? row.header : ""
  const question = typeof row.question === "string" ? row.question : ""
  const options = Array.isArray(row.options)
    ? row.options.filter((item) => typeof item === "string" && item).map((item) => item.trim()).filter(Boolean)
    : []
  const multiple = row.multiple === true
  const custom = row.custom !== false
  if (!header.trim() && !question.trim() && !options.length) return
  return {
    header: header.trim(),
    question: question.trim(),
    options,
    multiple,
    custom,
  }
}

function parsePendingQuestion(value: unknown): TelegramPendingQuestion | undefined {
  if (!value || typeof value !== "object") return
  const row = value as Record<string, unknown>
  const requestId = typeof row.requestId === "string" ? row.requestId.trim() : ""
  const sessionId = typeof row.sessionId === "string" ? row.sessionId.trim() : ""
  const createdAt = typeof row.createdAt === "number" && Number.isFinite(row.createdAt) ? row.createdAt : Date.now()
  const expiresAt = typeof row.expiresAt === "number" && Number.isFinite(row.expiresAt) ? row.expiresAt : Date.now()
  const list = Array.isArray(row.questions)
    ? row.questions
      .map(parsePendingQuestionEntry)
      .filter((item) => item !== undefined)
    : []
  const questions = list as TelegramPendingQuestionEntry[]
  if (!requestId || !sessionId || !questions.length) return
  return {
    requestId,
    sessionId,
    createdAt,
    expiresAt,
    questions,
  }
}

function parsePendingList(value: unknown): TelegramPendingItem[] {
  if (!Array.isArray(value)) return []
  const out: TelegramPendingItem[] = []
  for (const item of value) {
    if (!item || typeof item !== "object") continue
    const data = item as Partial<TelegramPendingItem>
    if (!data.id || typeof data.id !== "string") continue
    if (!data.sessionId || typeof data.sessionId !== "string") continue
    if (!data.text || typeof data.text !== "string") continue
    if (data.kind !== "question" && data.kind !== "permission" && data.kind !== "task-finished") continue
    if (typeof data.stampedAt !== "number" || !Number.isFinite(data.stampedAt) || data.stampedAt <= 0) continue
    if (typeof data.resolved !== "boolean") continue
    out.push({
      id: data.id,
      kind: data.kind,
      sessionId: data.sessionId,
      text: data.text,
      stampedAt: data.stampedAt,
      resolved: data.resolved,
    })
  }
  return out
}

function parseStore(input: string): StoreShape {
  if (!input.trim()) return emptyStore()
  const data = JSON.parse(input) as Partial<StoreShape>
  const sessions = data.sessions && typeof data.sessions === "object" ? data.sessions : {}
  const history = data.history && typeof data.history === "object" ? data.history : {}
  const notifications = data.notifications && typeof data.notifications === "object" ? data.notifications : {}
  const pending = data.pending && typeof data.pending === "object" ? data.pending : {}
  const out: Record<string, string> = {}
  const historyOut: Record<string, string[]> = {}
  const notifyOut: Record<string, boolean> = {}
  const pendingOut: Record<string, TelegramPendingQuestion[]> = {}
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
  for (const key of Object.keys(history)) {
    const next = parseHistoryList(history[key])
    if (!next.length) continue
    historyOut[key] = next
  }
  for (const key of Object.keys(pending)) {
    const rows = Array.isArray(pending[key]) ? pending[key] : []
    const next = rows
      .map(parsePendingQuestion)
      .filter((item) => item !== undefined)
    if (!next.length) continue
    pendingOut[key] = next as TelegramPendingQuestion[]
  }
  return {
    version: 3,
    sessions: out,
    history: historyOut,
    notifications: notifyOut,
    pending: pendingOut,
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
  historyGet?: (key: string) => Promise<string[]>
  historySet?: (key: string, ids: string[]) => Promise<void>
  notificationGet?: (key: string) => Promise<boolean>
  notificationSet?: (key: string, enabled: boolean) => Promise<void>
  questionList?: (key: string) => Promise<TelegramPendingQuestion[]>
  questionUpsert?: (key: string, question: TelegramPendingQuestion) => Promise<void>
  questionDelete?: (key: string, requestId: string) => Promise<void>
}

export function createTelegramSessionStore(path: string): TelegramSessionStore {
  // In-memory serialization only coordinates writes within this process.
  // Cross-process writers need an external coordinated store.
  const sessions = new Map<string, string>()
  const sessionIndex = new Map<string, Set<string>>()
  const history = new Map<string, string[]>()
  const notifications = new Map<string, boolean>()
  const pending = new Map<string, TelegramPendingQuestion[]>()

  function indexAdd(sessionId: string, key: string) {
    const set = sessionIndex.get(sessionId)
    if (set) {
      set.add(key)
      return
    }
    sessionIndex.set(sessionId, new Set([key]))
  }

  function indexDelete(sessionId: string, key: string) {
    const set = sessionIndex.get(sessionId)
    if (!set) return
    set.delete(key)
    if (set.size > 0) return
    sessionIndex.delete(sessionId)
  }

  function indexReplace(key: string, prev: string | undefined, next: string | undefined) {
    if (prev !== undefined && prev !== next) {
      indexDelete(prev, key)
    }
    if (next !== undefined && next !== prev) {
      indexAdd(next, key)
    }
  }
  const ready = readStore(path)
    .then((data) => {
      for (const [key, value] of Object.entries(data.sessions)) {
        sessions.set(key, value)
        indexAdd(value, key)
      }
      for (const [key, value] of Object.entries(data.history)) {
        history.set(key, value)
      }
      for (const [key, value] of Object.entries(data.notifications)) {
        notifications.set(key, value)
      }
      for (const [key, value] of Object.entries(data.pending)) {
        pending.set(key, value)
      }
    })
    .catch((error) => {
      console.warn("[TelegramBridge] session store load failed, starting empty", { path, error })
    })

  let writes = Promise.resolve()
  let ops = Promise.resolve()

  function flush() {
    const payload: StoreShape = {
      version: 3,
      sessions: Object.fromEntries(sessions),
      history: Object.fromEntries(history),
      notifications: Object.fromEntries(notifications),
      pending: Object.fromEntries(pending),
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
        indexReplace(key, prev, sessionId)
        await flush().catch((error) => {
          if (prev !== undefined) {
            sessions.set(key, prev)
            indexReplace(key, sessionId, prev)
            throw error
          }
          sessions.delete(key)
          indexReplace(key, sessionId, undefined)
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
        indexReplace(key, prev, undefined)
        await flush().catch((error) => {
          sessions.set(key, prev)
          indexReplace(key, undefined, prev)
          throw error
        })
      })
    },
    async sessionKeys(sessionId: string) {
      await ready
      const keys = sessionIndex.get(sessionId)
      if (!keys) return []
      return Array.from(keys)
    },
    async historyGet(key: string) {
      await ready
      return [...(history.get(key) || [])]
    },
    async historySet(key: string, ids: string[]) {
      await ready
      await run(async () => {
        const next = parseHistoryList(ids)
        const prev = history.get(key)
        if (!next.length) history.delete(key)
        if (next.length) history.set(key, next)
        await flush().catch((error) => {
          if (!prev?.length) {
            history.delete(key)
            throw error
          }
          history.set(key, prev)
          throw error
        })
      })
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
    async questionList(key: string) {
      await ready
      const rows = pending.get(key)
      if (!rows) return []
      return [...rows]
    },
    async questionUpsert(key: string, question: TelegramPendingQuestion) {
      await ready
      await run(async () => {
        const prev = pending.get(key) || []
        const filtered = prev.filter((item) => item.requestId !== question.requestId)
        const next = [...filtered, question]
          .sort((a, b) => a.createdAt - b.createdAt)
          .slice(-10)
        pending.set(key, next)
        await flush().catch((error) => {
          if (!prev.length) {
            pending.delete(key)
            throw error
          }
          pending.set(key, prev)
          throw error
        })
      })
    },
    async questionDelete(key: string, requestId: string) {
      await ready
      await run(async () => {
        const prev = pending.get(key) || []
        if (!prev.length) return
        const next = prev.filter((item) => item.requestId !== requestId)
        if (next.length === prev.length) return
        if (next.length) pending.set(key, next)
        if (!next.length) pending.delete(key)
        await flush().catch((error) => {
          pending.set(key, prev)
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
