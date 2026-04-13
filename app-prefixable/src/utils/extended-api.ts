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

interface SavedPromptsResponse extends SavedPromptsPayload {
  errors?: { global?: string; project?: string }
}

function validatePromptList(items: unknown[], field: "global" | "project"): StoredPrompt[] {
  const prompts: StoredPrompt[] = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (!isStoredPrompt(item)) throw new Error(`invalid saved prompts response: ${field}[${i}]`)
    prompts.push(item)
  }
  return prompts
}

function isStoredPrompt(p: unknown): p is StoredPrompt {
  if (!p || typeof p !== "object") return false
  const row = p as Record<string, unknown>
  if (typeof row.id !== "string") return false
  if (typeof row.title !== "string") return false
  if (typeof row.text !== "string") return false
  if (typeof row.createdAt !== "number") return false
  if (row.scope !== "global" && row.scope !== "project") return false
  return true
}

export async function readSavedPrompts(serverUrl: string, directory?: string): Promise<SavedPromptsPayload> {
  const params = new URLSearchParams()
  if (directory) params.set("directory", directory)
  const suffix = params.toString() ? `?${params.toString()}` : ""
  const res = await fetch(`${serverUrl}/api/ext/saved-prompts${suffix}`).catch(() => null)
  if (!res) throw new Error("failed to fetch saved prompts")
  if (!res.ok) throw new Error(`saved prompts read failed: ${res.status}`)
  const data = (await res.json().catch(() => null)) as SavedPromptsResponse | null
  if (!data || !Array.isArray(data.global) || !Array.isArray(data.project)) throw new Error("invalid saved prompts response")
  if (data.errors?.global || data.errors?.project) throw new Error("saved prompts response includes read errors")
  return {
    global: validatePromptList(data.global, "global"),
    project: validatePromptList(data.project, "project"),
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
