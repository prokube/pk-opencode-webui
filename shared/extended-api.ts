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

export interface StoredPrompt {
  id: string
  title: string
  text: string
  createdAt: number
  scope: "global" | "project"
}

type PromptScope = StoredPrompt["scope"]

function parseCreatedAt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value !== "string" || !value.trim()) return null
  const numeric = Number(value)
  if (Number.isFinite(numeric)) return numeric
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? null : timestamp
}

function parsePrompt(item: unknown, scope: PromptScope): StoredPrompt | null {
  if (!item || typeof item !== "object") return null
  const row = item as Record<string, unknown>
  if (typeof row.id !== "string" || !row.id) return null
  const title = typeof row.title === "string" ? row.title : typeof row.name === "string" ? row.name : null
  const text = typeof row.text === "string" ? row.text : typeof row.prompt === "string" ? row.prompt : typeof row.content === "string" ? row.content : null
  const createdAt = parseCreatedAt(row.createdAt ?? row.created ?? row.timestamp)
  if (title === null || text === null || createdAt === null) return null
  return { id: row.id, title, text, createdAt, scope }
}

export function parsePromptList(raw: string, scope: PromptScope, strict = false): StoredPrompt[] {
  const parsed = JSON.parse(raw) as unknown
  const row = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : undefined
  const prompts = row?.prompts
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray(prompts)
      ? prompts
      : prompts && typeof prompts === "object" && Array.isArray((prompts as Record<string, unknown>)[scope])
        ? (prompts as Record<string, unknown>)[scope] as unknown[]
        : Array.isArray(row?.[scope])
          ? row[scope] as unknown[]
          : null
  if (!list) throw new Error(`invalid saved prompts format for ${scope}`)
  const parsedItems = list.map((item) => parsePrompt(item, scope))
  if (strict && parsedItems.some((item) => !item)) {
    throw new PromptMutationError(`invalid ${scope} saved prompt entry`, 409)
  }
  return parsedItems.filter((item): item is StoredPrompt => !!item)
}

async function readPromptFile(path: string, scope: PromptScope, strict = false) {
  try {
    return parsePromptList(await fs.promises.readFile(path, "utf-8"), scope, strict)
  } catch (e) {
    const code = typeof e === "object" && e && "code" in e ? (e as { code?: string }).code : undefined
    if (code === "ENOENT") return []
    throw e
  }
}

async function writePromptFile(path: string, prompts: StoredPrompt[]) {
  await fs.promises.mkdir(nodePath.dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`
  try {
    await fs.promises.writeFile(tmp, JSON.stringify(prompts, null, 2), "utf-8")
    await fs.promises.rename(tmp, path)
  } catch (e) {
    await fs.promises.rm(tmp, { force: true }).catch(() => undefined)
    throw e
  }
}

async function projectPromptFile(directory: string, create: boolean) {
  const parent = nodePath.join(directory, ".opencode")
  const directoryReal = await fs.promises.realpath(directory)
  if (create) await fs.promises.mkdir(parent, { recursive: true })
  const stat = await fs.promises.lstat(parent).catch((e) => {
    const code = typeof e === "object" && e && "code" in e ? (e as { code?: string }).code : undefined
    if (code === "ENOENT" && !create) return null
    throw e
  })
  if (!stat) return nodePath.join(directoryReal, ".opencode", "saved-prompts.json")
  const parentReal = await fs.promises.realpath(parent)
  if (!stat.isDirectory() || stat.isSymbolicLink() || !isPathWithinRoot(parentReal, directoryReal)) {
    throw new PromptMutationError("project prompt directory is not safe", 403)
  }
  const file = nodePath.join(parentReal, "saved-prompts.json")
  const fileStat = await fs.promises.lstat(file).catch((e) => {
    const code = typeof e === "object" && e && "code" in e ? (e as { code?: string }).code : undefined
    if (code === "ENOENT") return null
    throw e
  })
  if (fileStat?.isSymbolicLink()) throw new PromptMutationError("project prompt file is not safe", 403)
  return file
}

let promptMutationQueue = Promise.resolve()

function queuePromptMutation<T>(run: () => Promise<T>) {
  const result = promptMutationQueue.catch(() => undefined).then(run)
  promptMutationQueue = result.then(() => undefined, () => undefined)
  return result
}

function validPromptId(id: string) {
  return id.length > 0 && id.length <= 200 && !id.includes("/") && !id.includes("\\")
}

class PromptMutationError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

type PromptFiles = { global: string; project: string | null; directory: string | null }

async function promptFiles(url: URL): Promise<PromptFiles | Response> {
  const directory = url.searchParams.get("directory")
  const validated = directory ? await validatePath(directory, getAllowedRoot()) : null
  if (directory && !validated) return Response.json({ error: "directory must be within allowed directory" }, { status: 403 })
  try {
    return {
      global: nodePath.join(getConfigDir(), "saved-prompts.json"),
      project: validated ? await projectPromptFile(validated, false) : null,
      directory: validated,
    }
  } catch (e) {
    if (e instanceof PromptMutationError) return Response.json({ error: e.message }, { status: e.status })
    console.error("[ExtAPI] saved prompts path error:", e)
    return internalError("failed to resolve saved prompts path")
  }
}

type PromptState = { global: StoredPrompt[]; project: StoredPrompt[] }

async function readPrompts(files: PromptFiles, strict = false): Promise<PromptState> {
  const [global, project] = await Promise.all([
    readPromptFile(files.global, "global", strict),
    files.project ? readPromptFile(files.project, "project", strict) : Promise.resolve([]),
  ])
  if (strict) {
    const ids = [...global, ...project].map((prompt) => prompt.id)
    if (new Set(ids).size !== ids.length) throw new PromptMutationError("saved prompt IDs must be unique", 409)
  }
  return { global, project }
}

async function writePromptScope(files: PromptFiles, scope: PromptScope, prompts: StoredPrompt[]) {
  if (scope === "global") return writePromptFile(files.global, prompts)
  if (!files.directory) throw new PromptMutationError("project directory is required", 400)
  return writePromptFile(await projectPromptFile(files.directory, true), prompts)
}

async function mutatePrompts(
  files: PromptFiles,
  update: (state: PromptState) => PromptScope[],
) {
  try {
    return await queuePromptMutation(async () => {
      const state = await readPrompts(files, true)
      const previous = { global: [...state.global], project: [...state.project] }
      const changed = update(state)
      if (changed.length === 2) {
        const destination = changed[1]
        const source = changed[0]
        await writePromptScope(files, destination, state[destination])
        try {
          await writePromptScope(files, source, state[source])
        } catch (e) {
          await writePromptScope(files, destination, previous[destination]).catch(() => undefined)
          throw e
        }
        return Response.json(state)
      }
      if (changed.includes("global")) await writePromptScope(files, "global", state.global)
      if (changed.includes("project")) await writePromptScope(files, "project", state.project)
      return Response.json(state)
    })
  } catch (e) {
    if (e instanceof PromptMutationError) return Response.json({ error: e.message }, { status: e.status })
    console.error("[ExtAPI] saved prompts mutation error:", e)
    return internalError("failed to save prompts")
  }
}

function promptBodyError(body: unknown, partial = false) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "request body must be an object"
  const row = body as Record<string, unknown>
  if (!partial || "title" in row) {
    if (typeof row.title !== "string" || !row.title.trim() || row.title.length > 200) return "title must be between 1 and 200 characters"
  }
  if (!partial || "text" in row) {
    if (typeof row.text !== "string" || !row.text.trim() || row.text.length > 100_000) return "text must be between 1 and 100000 characters"
  }
  if (!partial || "scope" in row) {
    if (row.scope !== "global" && row.scope !== "project") return "scope must be global or project"
  }
  if ("id" in row && (typeof row.id !== "string" || !validPromptId(row.id))) return "id is invalid"
  if ("createdAt" in row && (typeof row.createdAt !== "number" || !Number.isFinite(row.createdAt))) return "createdAt is invalid"
  if (partial && !("title" in row) && !("text" in row) && !("scope" in row)) return "title, text, or scope is required"
}

function promptId(path: string) {
  const raw = path.slice("/api/ext/saved-prompts/".length)
  if (!raw || raw.includes("/")) return null
  try {
    const id = decodeURIComponent(raw)
    return validPromptId(id) ? id : null
  } catch {
    return null
  }
}

function internalError(message: string): Response {
  return Response.json({ error: message }, { status: 500 })
}

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"])

function firstForwarded(value: string | null) {
  return value?.split(",", 1)[0]?.trim()
}

export function isSameOriginRequest(req: Request, url = new URL(req.url)) {
  if (req.headers.get("Sec-Fetch-Site") === "cross-site") return false
  const origin = req.headers.get("Origin")
  if (!origin) return true
  try {
    const source = new URL(origin)
    const host = firstForwarded(req.headers.get("X-Forwarded-Host")) ?? url.host
    const protocol = firstForwarded(req.headers.get("X-Forwarded-Proto")) ?? url.protocol.slice(0, -1)
    return source.host === host && source.protocol === `${protocol}:`
  } catch {
    return false
  }
}

export function isMutation(method: string) {
  return MUTATING_METHODS.has(method.toUpperCase())
}

function withSecurityHeaders(response: Response) {
  const headers = new Headers(response.headers)
  headers.set("Cross-Origin-Resource-Policy", "same-origin")
  headers.set("Referrer-Policy", "no-referrer")
  headers.set("X-Content-Type-Options", "nosniff")
  headers.append("Vary", "Origin")
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
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
  if (!path.startsWith("/api/ext/")) return undefined

  if (isMutation(method) && !isSameOriginRequest(req, url)) {
    return withSecurityHeaders(Response.json({ error: "cross-origin request denied" }, { status: 403 }))
  }

  const response = await handleExtendedRoute(path, method, url, req)
  if (!response) return undefined
  return withSecurityHeaders(response)
}

async function handleExtendedRoute(
  path: string,
  method: string,
  url: URL,
  req: Request,
): Promise<Response | undefined> {
  if (path === "/api/ext/saved-prompts" && method === "GET") {
    const files = await promptFiles(url)
    if (files instanceof Response) return files
    try {
      return Response.json(await readPrompts(files))
    } catch (e) {
      console.error("[ExtAPI] saved prompts read error:", e)
      return internalError("failed to read saved prompts")
    }
  }

  if (path === "/api/ext/saved-prompts" && method === "POST") {
    const files = await promptFiles(url)
    if (files instanceof Response) return files
    const body = await req.json().catch(() => null)
    const error = promptBodyError(body)
    if (error) return Response.json({ error }, { status: 400 })
    const row = body as { title: string; text: string; scope: PromptScope; id?: string; createdAt?: number }
    if (row.scope === "project" && !files.project) {
      return Response.json({ error: "directory is required for project prompts" }, { status: 400 })
    }
    const prompt: StoredPrompt = {
      id: row.id ?? crypto.randomUUID(),
      title: row.title.trim(),
      text: row.text,
      createdAt: row.createdAt ?? Date.now(),
      scope: row.scope,
    }
    return mutatePrompts(files, (state) => {
      const existing = [...state.global, ...state.project].find((item) => item.id === prompt.id)
      if (existing) {
        if (existing.title === prompt.title && existing.text === prompt.text && existing.createdAt === prompt.createdAt && existing.scope === prompt.scope) return []
        throw new PromptMutationError("prompt id already exists", 409)
      }
      state[row.scope].unshift(prompt)
      return [row.scope]
    })
  }

  if (path.startsWith("/api/ext/saved-prompts/") && (method === "PATCH" || method === "DELETE")) {
    const id = promptId(path)
    if (!id) return Response.json({ error: "invalid prompt id" }, { status: 400 })
    const files = await promptFiles(url)
    if (files instanceof Response) return files

    if (method === "DELETE") {
      return mutatePrompts(files, (state) => {
        const scope = (["project", "global"] as const).find((key) => state[key].some((item) => item.id === id))
        if (!scope) throw new PromptMutationError("prompt not found", 404)
        state[scope] = state[scope].filter((item) => item.id !== id)
        return [scope]
      })
    }

    const body = await req.json().catch(() => null)
    const error = promptBodyError(body, true)
    if (error) return Response.json({ error }, { status: 400 })
    const row = body as { title?: string; text?: string; scope?: PromptScope }
    if (row.scope === "project" && !files.project) {
      return Response.json({ error: "directory is required for project prompts" }, { status: 400 })
    }
    return mutatePrompts(files, (state) => {
      const source = (["project", "global"] as const).find((key) => state[key].some((item) => item.id === id))
      if (!source) throw new PromptMutationError("prompt not found", 404)
      const index = state[source].findIndex((item) => item.id === id)
      const current = state[source][index]
      const scope = row.scope ?? source
      const prompt = {
        ...current,
        ...(row.title === undefined ? {} : { title: row.title.trim() }),
        ...(row.text === undefined ? {} : { text: row.text }),
        scope,
      }
      if (scope === source) {
        state[source][index] = prompt
        return [source]
      }
      state[source].splice(index, 1)
      state[scope].unshift(prompt)
      return [source, scope]
    })
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
        return Response.json({ success: true, removed: false })
      }

      // Write back (as plain JSON since we stripped comments).
      // The full config object is preserved — only mcp[serverName] was deleted above.
      const output = JSON.stringify(config, null, 2)
      if (Array.isArray(config.disabled_providers)) {
        console.log("[ExtAPI] Preserving disabled_providers:", config.disabled_providers)
      }
      await fs.promises.writeFile(configPath, output)
      console.log("[ExtAPI] Config saved")

      return Response.json({ success: true, removed: true })
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
