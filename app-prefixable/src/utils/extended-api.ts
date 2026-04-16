/**
 * Extended API functions
 *
 * These functions call endpoints that are handled directly by the serve-ui.ts
 * Bun server, not proxied to the OpenCode backend. This allows us to add
 * features without modifying upstream code.
 */

/**
 * Create a directory recursively
 */
export async function mkdir(serverUrl: string, path: string): Promise<boolean> {
  try {
    const res = await fetch(`${serverUrl}/api/ext/mkdir`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    })
    return res.ok && (await res.json()) === true
  } catch (e) {
    console.error("[extended-api] mkdir failed:", e)
    return false
  }
}

/**
 * List directories in a given path
 */
export async function listDirs(
  serverUrl: string,
  directory: string,
  options?: { query?: string; limit?: number; depth?: number },
): Promise<string[]> {
  try {
    const params = new URLSearchParams({ directory })
    if (options?.query) params.set("query", options.query)
    if (options?.limit) params.set("limit", options.limit.toString())
    if (options?.depth) params.set("depth", options.depth.toString())

    const res = await fetch(`${serverUrl}/api/ext/list-dirs?${params}`)
    if (!res.ok) return []
    return await res.json()
  } catch (e) {
    console.error("[extended-api] listDirs failed:", e)
    return []
  }
}

/**
 * Write content to a file (creates parent directories if needed)
 */
export async function writeFile(serverUrl: string, path: string, content: string): Promise<boolean> {
  const res = await fetch(`${serverUrl}/api/ext/file`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, content }),
  }).catch(() => null)
  if (!res?.ok) {
    console.error("[extended-api] writeFile failed:", res?.status)
    return false
  }
  return true
}

export interface StoredPrompt {
  id: string
  title: string
  text: string
  createdAt: number
  scope: "global" | "project"
}

interface SavedPromptsPayload {
  global: StoredPrompt[]
  project: StoredPrompt[]
}

interface SavedPromptsResponse {
  prompts?: { global?: unknown[]; project?: unknown[] }
  global?: unknown[] | { prompts?: unknown[] }
  project?: unknown[] | { prompts?: unknown[] }
  errors?: { global?: string; project?: string }
}

function validatePromptList(items: unknown[], field: "global" | "project"): StoredPrompt[] {
  const prompts: StoredPrompt[] = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const prompt = toStoredPrompt(item, field)
    if (!prompt) {
      console.warn(`[extended-api] skipped invalid saved prompt at ${field}[${i}]`)
      continue
    }
    prompts.push(prompt)
  }
  return prompts
}

function parseCreatedAt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const numeric = Number(trimmed)
  if (Number.isFinite(numeric)) return numeric
  const timestamp = Date.parse(trimmed)
  if (!Number.isNaN(timestamp)) return timestamp
  return null
}

function toStoredPrompt(item: unknown, fallbackScope: "global" | "project"): StoredPrompt | null {
  if (!item || typeof item !== "object") return null
  const row = item as Record<string, unknown>
  const id = typeof row.id === "string" ? row.id : null
  if (id === null) return null
  const title = typeof row.title === "string" ? row.title : typeof row.name === "string" ? row.name : null
  if (title === null) return null
  const text =
    typeof row.text === "string"
      ? row.text
      : typeof row.prompt === "string"
        ? row.prompt
        : typeof row.content === "string"
          ? row.content
          : null
  if (text === null) return null
  const createdAt = parseCreatedAt(row.createdAt ?? row.created ?? row.timestamp)
  if (createdAt === null) return null
  const scope = row.scope === "global" || row.scope === "project" ? row.scope : fallbackScope
  return { id, title, text, createdAt, scope }
}

function readPromptArray(data: SavedPromptsResponse, field: "global" | "project"): unknown[] | null {
  const direct = data[field]
  if (Array.isArray(direct)) return direct
  if (direct && typeof direct === "object") {
    const nested = (direct as { prompts?: unknown }).prompts
    if (Array.isArray(nested)) return nested
  }
  const nested = data.prompts?.[field]
  if (Array.isArray(nested)) return nested
  return null
}

export async function readSavedPrompts(serverUrl: string, directory?: string): Promise<SavedPromptsPayload> {
  const params = new URLSearchParams()
  if (directory) params.set("directory", directory)
  const suffix = params.toString() ? `?${params.toString()}` : ""
  const res = await fetch(`${serverUrl}/api/ext/saved-prompts${suffix}`).catch(() => null)
  if (!res) throw new Error("failed to fetch saved prompts")
  if (!res.ok) throw new Error(`saved prompts read failed: ${res.status}`)
  const data = (await res.json().catch(() => null)) as SavedPromptsResponse | null
  if (!data || typeof data !== "object") throw new Error("invalid saved prompts response")
  const global = readPromptArray(data, "global")
  const project = readPromptArray(data, "project")
  if (!global || !project) throw new Error("invalid saved prompts response")
  if (data.errors?.global || data.errors?.project) {
    console.warn("[extended-api] saved prompts response includes read warnings", data.errors)
  }
  return {
    global: validatePromptList(global, "global"),
    project: validatePromptList(project, "project"),
  }
}

export async function writeSavedPrompts(
  serverUrl: string,
  directory: string | undefined,
  global: StoredPrompt[],
  project: StoredPrompt[],
): Promise<boolean> {
  const params = new URLSearchParams()
  if (directory) params.set("directory", directory)
  const suffix = params.toString() ? `?${params.toString()}` : ""
  const res = await fetch(`${serverUrl}/api/ext/saved-prompts${suffix}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ global, project }),
  }).catch(() => null)
  return !!res?.ok
}

export interface SessionAlarmState {
  sessionId: string
  sourceId: string
  enabled: boolean
}

const TELEGRAM_SOURCE_ID_CACHE_TTL_MS = 30_000

const telegramSourceIdCache = new Map<string, { sourceId: string; expiresAt: number }>()
const telegramSourceIdPending = new Map<string, Promise<string | undefined>>()

function sourceCacheKey(serverUrl: string, directory: string) {
  return `${serverUrl}::${directory}`
}

export function invalidateTelegramSourceIdCache(serverUrl?: string, directory?: string) {
  const url = serverUrl?.trim()
  const dir = directory?.trim()
  if (!url) {
    telegramSourceIdCache.clear()
    telegramSourceIdPending.clear()
    return
  }
  if (!dir) {
    for (const key of telegramSourceIdCache.keys()) {
      if (!key.startsWith(`${url}::`)) continue
      telegramSourceIdCache.delete(key)
    }
    for (const key of telegramSourceIdPending.keys()) {
      if (!key.startsWith(`${url}::`)) continue
      telegramSourceIdPending.delete(key)
    }
    return
  }
  const key = sourceCacheKey(url, dir)
  telegramSourceIdCache.delete(key)
  telegramSourceIdPending.delete(key)
}

function sourceFromSettings(data: unknown, directory?: string) {
  if (!directory) return
  if (!data || typeof data !== "object") return
  const settings = (data as { settings?: unknown }).settings
  if (!settings || typeof settings !== "object") return
  const rootDirectory = (settings as { directory?: unknown }).directory
  if (typeof rootDirectory === "string" && rootDirectory === directory) {
    return "default"
  }
  const sources = (settings as { sources?: unknown }).sources
  if (!Array.isArray(sources)) return
  const match = sources.find((item) => {
    if (!item || typeof item !== "object") return false
    const source = item as { id?: unknown; directory?: unknown; enabled?: unknown }
    if (source.enabled === false) return false
    if (typeof source.id !== "string") return false
    if (typeof source.directory !== "string") return false
    return source.directory === directory
  }) as { id?: string } | undefined
  if (!match?.id) return
  return match.id
}

export async function resolveTelegramSourceId(serverUrl: string, directory?: string): Promise<string | undefined> {
  const dir = directory?.trim()
  if (!dir) return
  const key = sourceCacheKey(serverUrl, dir)
  const cached = telegramSourceIdCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.sourceId
  if (cached) telegramSourceIdCache.delete(key)
  const pending = telegramSourceIdPending.get(key)
  if (pending) return pending
  const next = fetch(`${serverUrl}/api/ext/telegram/settings`)
    .then(async (res) => {
      if (!res.ok) return
      const data = (await res.json().catch(() => null)) as unknown
      const sourceId = sourceFromSettings(data, dir)
      if (!sourceId) return
      telegramSourceIdCache.set(key, { sourceId, expiresAt: Date.now() + TELEGRAM_SOURCE_ID_CACHE_TTL_MS })
      return sourceId
    })
    .catch(() => undefined)
    .finally(() => {
      telegramSourceIdPending.delete(key)
    })
  telegramSourceIdPending.set(key, next)
  return next
}

/** Read session alarm state from the server (Telegram bridge). Returns null on failure. */
export async function getSessionAlarm(serverUrl: string, sessionId: string, sourceId?: string): Promise<SessionAlarmState | null> {
  const params = new URLSearchParams({ sessionId })
  const source = sourceId?.trim()
  if (source) params.set("sourceId", source)
  const res = await fetch(`${serverUrl}/api/ext/telegram/session-alarm?${params}`).catch(() => null)
  if (!res) {
    console.warn("[extended-api] getSessionAlarm: network error for session", sessionId)
    return null
  }
  if (!res.ok) {
    console.warn("[extended-api] getSessionAlarm failed:", res.status)
    return null
  }
  const data = (await res.json().catch(() => null)) as { sessionId?: string; enabled?: boolean } | null
  if (!data || typeof data.enabled !== "boolean") {
    console.warn("[extended-api] getSessionAlarm: invalid response data")
    return null
  }
  return {
    sessionId: data.sessionId || sessionId,
    sourceId: typeof (data as { sourceId?: unknown }).sourceId === "string" ? (data as { sourceId: string }).sourceId : source || "default",
    enabled: data.enabled,
  }
}

/** Update session alarm state on the server (Telegram bridge). Returns true on success. */
export async function setSessionAlarm(serverUrl: string, sessionId: string, enabled: boolean, sourceId?: string): Promise<boolean> {
  const source = sourceId?.trim()
  const res = await fetch(`${serverUrl}/api/ext/telegram/session-alarm`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(source ? { sessionId, sourceId: source, enabled } : { sessionId, enabled }),
  }).catch(() => null)
  if (!res) {
    console.warn("[extended-api] setSessionAlarm: network error for session", sessionId)
    return false
  }
  if (!res.ok) {
    console.warn("[extended-api] setSessionAlarm failed:", res.status)
    return false
  }
  return true
}
