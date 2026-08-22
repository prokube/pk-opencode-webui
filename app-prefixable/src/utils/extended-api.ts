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

export type PromptScope = "global" | "project"

export interface SavedPrompt {
  id: string
  title: string
  text: string
  createdAt: number
  scope: PromptScope
}

export interface SavedPromptState {
  global: SavedPrompt[]
  project: SavedPrompt[]
}

function parseCreatedAt(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value !== "string" || !value.trim()) return null
  const numeric = Number(value)
  if (Number.isFinite(numeric)) return numeric
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? null : timestamp
}

function parsePrompt(value: unknown, scope: PromptScope): SavedPrompt | null {
  if (!value || typeof value !== "object") return null
  const row = value as Record<string, unknown>
  const title = typeof row.title === "string" ? row.title : typeof row.name === "string" ? row.name : null
  const text = typeof row.text === "string" ? row.text : typeof row.prompt === "string" ? row.prompt : typeof row.content === "string" ? row.content : null
  const createdAt = parseCreatedAt(row.createdAt ?? row.created ?? row.timestamp)
  if (typeof row.id !== "string" || !row.id || title === null || text === null || createdAt === null) return null
  return { id: row.id, title, text, createdAt, scope }
}

function promptArray(value: unknown, scope: PromptScope) {
  if (Array.isArray(value)) return value
  if (!value || typeof value !== "object") return null
  const row = value as Record<string, unknown>
  if (Array.isArray(row.prompts)) return row.prompts
  if (Array.isArray(row[scope])) return row[scope] as unknown[]
  if (row.prompts && typeof row.prompts === "object") {
    const nested = (row.prompts as Record<string, unknown>)[scope]
    if (Array.isArray(nested)) return nested
  }
  return null
}

export function parseSavedPromptState(value: unknown): SavedPromptState {
  if (!value || typeof value !== "object") throw new Error("invalid saved prompts response")
  const row = value as Record<string, unknown>
  const global = promptArray(row.global ?? value, "global")
  const project = promptArray(row.project ?? value, "project")
  if (!global || !project) throw new Error("invalid saved prompts response")
  return {
    global: global.map((item) => parsePrompt(item, "global")).filter((item): item is SavedPrompt => !!item),
    project: project.map((item) => parsePrompt(item, "project")).filter((item): item is SavedPrompt => !!item),
  }
}

function savedPromptUrl(serverUrl: string, directory?: string, id?: string) {
  const path = `${serverUrl}/api/ext/saved-prompts${id ? `/${encodeURIComponent(id)}` : ""}`
  if (!directory) return path
  return `${path}?${new URLSearchParams({ directory })}`
}

async function savedPromptRequest(serverUrl: string, directory: string | undefined, init?: RequestInit, id?: string) {
  const res = await fetch(savedPromptUrl(serverUrl, directory, id), init).catch(() => null)
  if (!res?.ok) throw new Error(`saved prompts request failed: ${res?.status ?? "network"}`)
  return parseSavedPromptState(await res.json())
}

export function readSavedPrompts(serverUrl: string, directory?: string) {
  return savedPromptRequest(serverUrl, directory)
}

export function createSavedPrompt(serverUrl: string, directory: string | undefined, prompt: { title: string; text: string; scope: PromptScope }) {
  return savedPromptRequest(serverUrl, directory, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(prompt),
  })
}

export function updateSavedPrompt(serverUrl: string, directory: string | undefined, id: string, patch: Partial<Pick<SavedPrompt, "title" | "text" | "scope">>) {
  return savedPromptRequest(serverUrl, directory, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  }, id)
}

export function deleteSavedPrompt(serverUrl: string, directory: string | undefined, id: string) {
  return savedPromptRequest(serverUrl, directory, { method: "DELETE" }, id)
}
