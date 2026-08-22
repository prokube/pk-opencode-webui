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
