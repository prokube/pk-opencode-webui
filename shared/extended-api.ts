/**
 * Extended API endpoints
 *
 * These endpoints are handled directly by the UI server (dev.ts / serve-ui.ts),
 * NOT proxied to the OpenCode backend. This allows us to add features without
 * modifying upstream code.
 */

import * as fs from "node:fs"
import * as nodePath from "node:path"
import * as os from "node:os"
import { readTelegramSettings, updateTelegramSettings } from "./telegram-settings"

/** Resolve the working directory from a query param, falling back to cwd */
function resolveDir(url: URL): string {
  return url.searchParams.get("directory") || process.cwd()
}

/**
 * Validate that a path is safe (within allowed root, no traversal attacks).
 * Returns the normalized absolute path if valid, or null if invalid.
 */
async function nearestExistingRealPath(path: string): Promise<string | null> {
  let current = nodePath.resolve(path)
  for (;;) {
    try {
      return await fs.promises.realpath(current)
    } catch (e) {
      const code = typeof e === "object" && e && "code" in e ? (e as { code?: string }).code : undefined
      if (code !== "ENOENT") throw e
      const parent = nodePath.dirname(current)
      if (parent === current) return null
      current = parent
    }
  }
}

function isPathWithinRoot(path: string, root: string): boolean {
  const relative = nodePath.relative(root, path)
  if (!relative) return true
  if (nodePath.isAbsolute(relative)) return false
  if (relative === "..") return false
  if (relative.startsWith(`..${nodePath.sep}`)) return false
  return true
}

async function validatePath(inputPath: string, allowedRoot: string): Promise<string | null> {
  const resolved = nodePath.resolve(allowedRoot, inputPath)
  const normalizedRoot = nodePath.resolve(allowedRoot)

  if (!isPathWithinRoot(resolved, normalizedRoot)) {
    return null
  }

  const rootReal = await fs.promises.realpath(normalizedRoot).catch(() => normalizedRoot)
  const targetReal = await nearestExistingRealPath(resolved)
  if (!targetReal) return null
  if (!isPathWithinRoot(targetReal, rootReal)) {
    return null
  }

  return resolved
}

/**
 * Validate that a server name contains only safe characters.
 * Prevents path traversal and other injection attacks.
 */
function isValidServerName(name: string): boolean {
  // Allow alphanumeric, hyphens, underscores, dots (but not starting with dot)
  // Reject empty strings, path separators, and traversal sequences
  if (!name || name.length === 0 || name.length > 100) return false
  if (name.includes("/") || name.includes("\\") || name.includes("..")) return false
  if (name.startsWith(".")) return false
  return /^[a-zA-Z0-9][a-zA-Z0-9_\-\.]*$/.test(name)
}

/**
 * Get the allowed root directory for filesystem operations.
 * Defaults to HOME directory.
 */
function getAllowedRoot(): string {
  return process.env.OPENCODE_WORKSPACE_ROOT || process.env.HOME || os.homedir()
}

function getConfigDir(): string {
  const homeDir = process.env.HOME || os.homedir()
  return process.env.OPENCODE_CONFIG_DIR || nodePath.join(homeDir, ".config", "opencode")
}

function internalError(message: string): Response {
  return Response.json({ error: message }, { status: 500 })
}

interface StoredPrompt {
  id: string
  title: string
  text: string
  createdAt: number
  scope?: "global" | "project"
}

function isStoredPrompt(p: unknown): p is StoredPrompt {
  if (!p || typeof p !== "object") return false
  const row = p as Record<string, unknown>
  if (typeof row.id !== "string") return false
  if (typeof row.title !== "string") return false
  if (typeof row.text !== "string") return false
  if (typeof row.createdAt !== "number") return false
  if (row.scope !== undefined && row.scope !== "global" && row.scope !== "project") return false
  return true
}

function parsePromptList(raw: string): StoredPrompt[] {
  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed)) throw new Error("saved prompts content must be an array")
  for (const item of parsed) {
    if (!isStoredPrompt(item)) throw new Error("saved prompts content has invalid entries")
  }
  return parsed
}

function invalidPromptIndex(list: unknown[]): number {
  return list.findIndex((item) => !isStoredPrompt(item))
}

async function readPromptFile(path: string): Promise<StoredPrompt[]> {
  try {
    const content = await fs.promises.readFile(path, "utf-8")
    return parsePromptList(content)
  } catch (e) {
    const code = typeof e === "object" && e && "code" in e ? (e as { code?: string }).code : undefined
    if (code !== "ENOENT") throw e
    return []
  }
}

function sanitizePrompt(p: StoredPrompt, scope: "global" | "project"): StoredPrompt {
  return {
    id: p.id,
    title: p.title,
    text: p.text,
    createdAt: p.createdAt,
    scope,
  }
}

async function readPromptScope(path: string, scope: "global" | "project") {
  try {
    const prompts = await readPromptFile(path)
    return { prompts: prompts.map((p) => sanitizePrompt(p, scope)) }
  } catch (e) {
    console.error(`[ExtAPI] saved-prompts ${scope} read error:`, e)
    return { prompts: [] as StoredPrompt[], error: `failed to read ${scope} saved prompts` }
  }
}

async function writePromptFile(path: string, prompts: StoredPrompt[]) {
  const parentDir = nodePath.dirname(path)
  await fs.promises.mkdir(parentDir, { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const content = JSON.stringify(prompts, null, 2)
  try {
    await fs.promises.writeFile(tmp, content, "utf-8")
    if (process.platform === "win32") {
      await fs.promises.rm(path, { force: true }).catch((e) => {
        const code = typeof e === "object" && e && "code" in e ? (e as { code?: string }).code : undefined
        if (code !== "ENOENT") throw e
      })
    }
    await fs.promises.rename(tmp, path)
  } catch (e) {
    await fs.promises.unlink(tmp).catch(() => undefined)
    throw e
  }
}

/**
 * API paths that should be proxied to the OpenCode API server.
 * Extended endpoints (/api/ext/*) are NOT in this list - they're handled separately.
 */
export const API_PATHS = [
  "/api",
  "/event",
  "/config",
  "/provider",
  "/project",
  "/permission",
  "/pty",
  "/mcp",
  "/file",
  "/health",
  "/path",
  "/command",
  "/auth",
  "/app",
  "/agent",
  "/session",
  "/global",
  "/skill",
  "/lsp",
  "/formatter",
  "/doc",
  "/log",
  "/instance",
  "/question",
  "/find",
  "/vcs",
]

/**
 * Check if a path should be proxied to the OpenCode API server.
 */
export function isApiPath(path: string): boolean {
  return API_PATHS.some((p) => path === p || path.startsWith(p + "/") || path.startsWith(p + "?"))
}

/**
 * Handle extended API endpoints.
 * Returns a Response if the path matches an extended endpoint, otherwise undefined.
 */
export async function handleExtendedEndpoint(
  path: string,
  method: string,
  url: URL,
  req: Request,
): Promise<Response | undefined> {
  if (path === "/api/ext/telegram/settings" && method === "GET") {
    const data = await readTelegramSettings().catch((error) => {
      console.error("[ExtAPI] telegram settings read error", error)
      return null
    })
    if (!data) {
      return Response.json({ error: "failed to read telegram settings" }, { status: 500 })
    }
    return Response.json(data)
  }

  if (path === "/api/ext/telegram/settings" && method === "PUT") {
    const body = await req.json().catch(() => null)
    const rawSettings = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).settings : null
    const result = await updateTelegramSettings(rawSettings).catch((error) => {
      console.error("[ExtAPI] telegram settings update error", error)
      return null
    })
    if (!result) {
      return Response.json({ error: "failed to update telegram settings" }, { status: 500 })
    }
    if (!result.ok) {
      return Response.json({ error: "validation_failed", errors: result.errors }, { status: 400 })
    }
    return Response.json(result)
  }

  // GET /api/ext/saved-prompts - Read global + project prompts
  if (path === "/api/ext/saved-prompts" && method === "GET") {
    const directory = url.searchParams.get("directory")
    const allowedRoot = getAllowedRoot()
    const validatedDir = directory ? await validatePath(directory, allowedRoot) : null
    if (directory && !validatedDir) {
      console.warn("[ExtAPI] saved-prompts read: path outside allowed root:", directory)
      return Response.json({ error: "directory must be within allowed directory" }, { status: 403 })
    }

    const configDir = getConfigDir()
    const globalPath = nodePath.join(configDir, "saved-prompts.json")
    const projectPath = validatedDir ? nodePath.join(validatedDir, ".opencode", "saved-prompts.json") : null

    const globalResult = await readPromptScope(globalPath, "global")
    const projectResult = projectPath ? await readPromptScope(projectPath, "project") : { prompts: [] as StoredPrompt[] }

    if (!globalResult.error && !projectResult.error) {
      return Response.json({ global: globalResult.prompts, project: projectResult.prompts })
    }

    return Response.json(
      {
        error: "failed to read saved prompts",
        errors: {
          ...(globalResult.error ? { global: globalResult.error } : {}),
          ...(projectResult.error ? { project: projectResult.error } : {}),
        },
      },
      { status: 500 },
    )
  }

  // PUT /api/ext/saved-prompts - Write global + project prompts
  if (path === "/api/ext/saved-prompts" && method === "PUT") {
    const directory = url.searchParams.get("directory")
    const allowedRoot = getAllowedRoot()
    const validatedDir = directory ? await validatePath(directory, allowedRoot) : null
    if (directory && !validatedDir) {
      console.warn("[ExtAPI] saved-prompts write: path outside allowed root:", directory)
      return Response.json({ error: "directory must be within allowed directory" }, { status: 403 })
    }

    const body = await req.json().catch(() => null)
    const global = Array.isArray(body?.global) ? body.global : null
    const project = Array.isArray(body?.project) ? body.project : null
    if (!global || !project) {
      return Response.json({ error: "global and project arrays are required" }, { status: 400 })
    }

    const configDir = getConfigDir()
    const globalPath = nodePath.join(configDir, "saved-prompts.json")
    const projectPath = validatedDir ? nodePath.join(validatedDir, ".opencode", "saved-prompts.json") : null
    const badGlobal = invalidPromptIndex(global)
    if (badGlobal !== -1) {
      return Response.json({ error: `global[${badGlobal}] is invalid` }, { status: 400 })
    }
    const badProject = invalidPromptIndex(project)
    if (badProject !== -1) {
      return Response.json({ error: `project[${badProject}] is invalid` }, { status: 400 })
    }
    if (project.length > 0 && !validatedDir) {
      return Response.json({ error: "directory is required for project prompts" }, { status: 400 })
    }

    try {
      await writePromptFile(globalPath, global.map((p) => sanitizePrompt(p, "global")))
      if (projectPath) {
        await writePromptFile(projectPath, project.map((p) => sanitizePrompt(p, "project")))
      }
      return Response.json({ success: true })
    } catch (e) {
      console.error("[ExtAPI] saved-prompts write error:", e)
      return internalError("failed to write saved prompts")
    }
  }

  // POST /api/ext/mkdir - Create directory recursively
  if (path === "/api/ext/mkdir" && method === "POST") {
    try {
      const body = await req.json()
      const dirPath = body.path
      if (!dirPath || typeof dirPath !== "string") {
        return Response.json({ error: "path is required" }, { status: 400 })
      }

      // Validate path is within allowed root
      const allowedRoot = getAllowedRoot()
      const validatedPath = await validatePath(dirPath, allowedRoot)
      if (!validatedPath) {
        console.warn("[ExtAPI] mkdir: path outside allowed root:", dirPath)
        return Response.json({ error: "path must be within allowed directory" }, { status: 403 })
      }

      console.log("[ExtAPI] mkdir:", validatedPath)
      await fs.promises.mkdir(validatedPath, { recursive: true })
      return Response.json(true)
    } catch (e) {
      console.error("[ExtAPI] mkdir error:", e)
      return Response.json(false)
    }
  }

  // GET /api/ext/list-dirs - List directories in a given path
  if (path === "/api/ext/list-dirs" && method === "GET") {
    const directory = url.searchParams.get("directory")
    const query = url.searchParams.get("query") || ""
    const depthParam = parseInt(url.searchParams.get("depth") || "1", 10)
    const limitParam = parseInt(url.searchParams.get("limit") || "100", 10)
    // Cap depth to 1 or 2, default 1
    const depth = isNaN(depthParam) ? 1 : Math.min(Math.max(1, depthParam), 2)
    // Cap limit to reasonable maximum, handle NaN
    const limit = isNaN(limitParam) ? 100 : Math.min(Math.max(1, limitParam), 500)

    if (!directory) {
      return Response.json({ error: "directory parameter is required" }, { status: 400 })
    }

    // Validate path is within allowed root
    const allowedRoot = getAllowedRoot()
    const validatedDir = await validatePath(directory, allowedRoot)
    if (!validatedDir) {
      console.warn("[ExtAPI] list-dirs: path outside allowed root:", directory)
      return Response.json({ error: "directory must be within allowed directory" }, { status: 403 })
    }

    console.log("[ExtAPI] list-dirs:", validatedDir, "depth:", depth, "query:", query)

    try {
      const dirs: string[] = []
      const ignoreNested = new Set(["node_modules", "dist", "build", "target", "vendor", ".git"])
      const shouldIgnore = (name: string) => name.startsWith(".") || ignoreNested.has(name)

      // Read top-level directories
      const topEntries = await fs.promises.readdir(validatedDir, { withFileTypes: true }).catch(() => [])

      for (const entry of topEntries) {
        if (!entry.isDirectory()) continue
        if (shouldIgnore(entry.name)) continue
        dirs.push(entry.name + "/")

        // Read second-level directories only if depth >= 2
        if (depth >= 2) {
          const subDir = nodePath.join(validatedDir, entry.name)
          const subEntries = await fs.promises.readdir(subDir, { withFileTypes: true }).catch(() => [])
          for (const subEntry of subEntries) {
            if (!subEntry.isDirectory()) continue
            if (shouldIgnore(subEntry.name)) continue
            dirs.push(entry.name + "/" + subEntry.name + "/")
          }
        }
      }

      // Sort and filter by query
      dirs.sort()
      const queryLower = query.trim().toLowerCase()
      const filtered = queryLower ? dirs.filter((d) => d.toLowerCase().includes(queryLower)) : dirs

      return Response.json(filtered.slice(0, limit))
    } catch (e) {
      console.error("[ExtAPI] list-dirs error:", e)
      return Response.json([])
    }
  }

  // DELETE /api/ext/mcp/:name - Remove an MCP server from global config
  if (path.startsWith("/api/ext/mcp/") && method === "DELETE") {
    const rawServerName = path.replace("/api/ext/mcp/", "")
    
    // Decode URL-encoded name (handle malformed encoding)
    let serverName: string
    try {
      serverName = decodeURIComponent(rawServerName)
    } catch {
      return Response.json({ error: "invalid URL encoding" }, { status: 400 })
    }
    
    if (!serverName) {
      return Response.json({ error: "server name is required" }, { status: 400 })
    }
    
    if (!isValidServerName(serverName)) {
      return Response.json({ error: "invalid server name" }, { status: 400 })
    }

    console.log("[ExtAPI] Deleting MCP server:", serverName)

    try {
      // Find the global config file
      const configDir = getConfigDir()

      // Try both .jsonc and .json
      let configPath = nodePath.join(configDir, "opencode.jsonc")
      if (!fs.existsSync(configPath)) {
        configPath = nodePath.join(configDir, "opencode.json")
      }

      if (!fs.existsSync(configPath)) {
        return Response.json({ error: "Config file not found" }, { status: 404 })
      }

      // Read and parse config
      const content = await fs.promises.readFile(configPath, "utf-8")

      // Try parsing as JSON first, then strip comments if it fails
      let config: Record<string, unknown>
      try {
        config = JSON.parse(content)
      } catch {
        // Strip comments more carefully - only match // at start of line or after whitespace
        // (not inside strings like URLs)
        const jsonContent = content
          .split("\n")
          .map((line) => {
            // Remove trailing comments (// at end of line, but not in strings)
            // Simple heuristic: if line has even number of quotes before //, it's a comment
            const commentMatch = line.match(/^([^"]*(?:"[^"]*"[^"]*)*)\s*\/\//)
            if (commentMatch) {
              return commentMatch[1]
            }
            return line
          })
          .join("\n")
          .replace(/\/\*[\s\S]*?\*\//g, "") // Remove multi-line comments

        config = JSON.parse(jsonContent)
      }

      // Remove the MCP server (only modify the mcp key, preserving all other keys
      // like disabled_providers, enabled_providers, etc.)
      const mcpConfig = config.mcp as Record<string, unknown> | undefined
      if (mcpConfig && mcpConfig[serverName]) {
        delete mcpConfig[serverName]
        console.log("[ExtAPI] Removed MCP server from config:", serverName)
      } else {
        console.log("[ExtAPI] MCP server not found in config:", serverName)
        return Response.json({ error: "Server not found in config" }, { status: 404 })
      }

      // Write back (as plain JSON since we stripped comments).
      // The full config object is preserved — only mcp[serverName] was deleted above.
      const output = JSON.stringify(config, null, 2)
      if (Array.isArray(config.disabled_providers)) {
        console.log("[ExtAPI] Preserving disabled_providers:", config.disabled_providers)
      }
      await fs.promises.writeFile(configPath, output)
      console.log("[ExtAPI] Config saved")

      return Response.json({ success: true })
    } catch (e) {
      console.error("[ExtAPI] mcp delete error:", e)
      return internalError("failed to update MCP config")
    }
  }

  // PUT /api/ext/file - Write file content
  if (path === "/api/ext/file" && method === "PUT") {
    const body = await req.json().catch(() => null)
    if (!body || typeof body.path !== "string" || typeof body.content !== "string") {
      return Response.json({ error: "path and content are required" }, { status: 400 })
    }

    const allowedRoot = getAllowedRoot()
    const validatedPath = await validatePath(body.path, allowedRoot)
    if (!validatedPath) {
      console.warn("[ExtAPI] file write: path outside allowed root:", body.path)
      return Response.json({ error: "path must be within allowed directory" }, { status: 403 })
    }

    console.log("[ExtAPI] file write:", validatedPath)

    try {
      // Create parent directories if needed
      const parentDir = nodePath.dirname(validatedPath)
      await fs.promises.mkdir(parentDir, { recursive: true })

      await fs.promises.writeFile(validatedPath, body.content, "utf-8")
      return Response.json({ success: true })
    } catch (e) {
      console.error("[ExtAPI] file write error:", e)
      return internalError("failed to write file")
    }
  }

  // Not an extended endpoint
  return undefined
}
