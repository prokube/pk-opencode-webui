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
import { $ } from "bun"

// ---------------------------------------------------------------------------
// PR helpers
// ---------------------------------------------------------------------------

/** Run a gh command in the given cwd, return stdout or throw with stderr */
async function gh(args: string[], cwd: string): Promise<string> {
  const result = await $`gh ${args}`
    .cwd(cwd)
    .quiet()
    .nothrow()
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString().trim()
    throw new Error(stderr || `gh ${args[0]} failed with exit code ${result.exitCode}`)
  }
  return result.stdout.toString().trim()
}

/** Resolve the working directory from a query param, falling back to cwd */
function resolveDir(url: URL): string {
  return url.searchParams.get("directory") || process.cwd()
}

/** Validate branch name — no path traversal, reasonable characters */
function isValidBranch(name: string): boolean {
  if (!name || name.length > 250) return false
  if (name.includes("..") || name.includes("://")) return false
  return /^[a-zA-Z0-9/_.\-]+$/.test(name)
}

/**
 * Validate that a path is safe (within allowed root, no traversal attacks).
 * Returns the normalized absolute path if valid, or null if invalid.
 */
function validatePath(inputPath: string, allowedRoot: string): string | null {
  // Resolve to absolute path
  const resolved = nodePath.resolve(allowedRoot, inputPath)
  const normalizedRoot = nodePath.resolve(allowedRoot)

  // Handle edge case where root is "/" (filesystem root)
  if (normalizedRoot === "/") {
    // When root is /, allow any absolute path (but still normalized)
    return resolved
  }

  // Check that resolved path is within allowed root (prevents ../ traversal)
  // Must either equal the root exactly, or start with root + separator
  if (resolved !== normalizedRoot && !resolved.startsWith(normalizedRoot + nodePath.sep)) {
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
      const validatedPath = validatePath(dirPath, allowedRoot)
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
    const validatedDir = validatePath(directory, allowedRoot)
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
      const homeDir = process.env.HOME || os.homedir()
      const configDir = process.env.OPENCODE_CONFIG_DIR || nodePath.join(homeDir, ".config", "opencode")

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

      // Remove the MCP server
      const mcpConfig = config.mcp as Record<string, unknown> | undefined
      if (mcpConfig && mcpConfig[serverName]) {
        delete mcpConfig[serverName]
        console.log("[ExtAPI] Removed MCP server from config:", serverName)
      } else {
        console.log("[ExtAPI] MCP server not found in config:", serverName)
        return Response.json({ error: "Server not found in config" }, { status: 404 })
      }

      // Write back (as plain JSON since we stripped comments)
      await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2))
      console.log("[ExtAPI] Config saved")

      return Response.json({ success: true })
    } catch (e) {
      console.error("[ExtAPI] mcp delete error:", e)
      return Response.json({ error: String(e) }, { status: 500 })
    }
  }

  // -------------------------------------------------------------------------
  // PR endpoints — /api/ext/pr/*
  // All operations shell out to the `gh` CLI which must be installed and
  // authenticated in the server environment.
  // -------------------------------------------------------------------------

  // GET /api/ext/pr/info?directory=<path>
  // Returns current branch + PR metadata (null when no PR exists)
  if (path === "/api/ext/pr/info" && method === "GET") {
    const dir = resolveDir(url)
    const validatedDir = validatePath(dir, getAllowedRoot())
    if (!validatedDir) {
      return Response.json({ error: "Forbidden" }, { status: 403 })
    }
    try {
      // Get current branch from git
      const branchResult = await $`git rev-parse --abbrev-ref HEAD`.cwd(validatedDir).quiet().nothrow()
      const branch = branchResult.stdout.toString().trim()
      if (!branch || branchResult.exitCode !== 0) {
        return Response.json({ branch: null, dirty: 0, pr: null })
      }

      // Check for uncommitted changes (dirty count)
      const statusResult = await $`git status --porcelain`.cwd(validatedDir).quiet().nothrow()
      const dirty = statusResult.stdout.toString().trim().split("\n").filter(Boolean).length

      // Try to get PR for current branch
      let pr = null
      try {
        const prJson = await gh([
          "pr", "view",
          "--json", "number,title,state,url,headRefName,baseRefName,isDraft,mergeable,reviewDecision,unresolvedReviewThreadCount",
        ], validatedDir)
        pr = JSON.parse(prJson)
      } catch {
        // No PR for this branch — not an error
      }

      return Response.json({ branch, dirty, pr })
    } catch (e) {
      console.error("[ExtAPI] pr/info error:", e)
      return Response.json({ error: String(e) }, { status: 500 })
    }
  }

  // POST /api/ext/pr/create
  // Body: { directory, title, body?, base?, draft? }
  if (path === "/api/ext/pr/create" && method === "POST") {
    const body = await req.json() as Record<string, unknown>
    const dir = (body.directory as string) || process.cwd()
    const validatedDir = validatePath(dir, getAllowedRoot())
    if (!validatedDir) {
      return Response.json({ error: "Forbidden" }, { status: 403 })
    }
    const title = body.title as string | undefined
    const prBody = body.body as string | undefined
    const base = body.base as string | undefined
    const draft = body.draft === true

    if (!title || !title.trim()) {
      return Response.json({ error: "title is required" }, { status: 400 })
    }
    if (base && !isValidBranch(base)) {
      return Response.json({ error: "invalid base branch name" }, { status: 400 })
    }

    try {
      const args = ["pr", "create", "--title", title.trim()]
      if (prBody) { args.push("--body", prBody) }
      else { args.push("--body", "") }
      if (base) args.push("--base", base)
      if (draft) args.push("--draft")

      const out = await gh(args, validatedDir)
      // gh pr create outputs the PR URL on success
      const prUrl = out.split("\n").find(l => l.startsWith("https://")) || out.trim()

      // Fetch fresh PR info to return
      const prJson = await gh([
        "pr", "view",
        "--json", "number,title,state,url,headRefName,baseRefName,isDraft,mergeable,reviewDecision,unresolvedReviewThreadCount",
      ], validatedDir)
      return Response.json({ url: prUrl, pr: JSON.parse(prJson) })
    } catch (e) {
      console.error("[ExtAPI] pr/create error:", e)
      return Response.json({ error: String(e) }, { status: 500 })
    }
  }

  // POST /api/ext/pr/commit
  // Stage tracked files and commit. Body: { directory, message }
  if (path === "/api/ext/pr/commit" && method === "POST") {
    const body = await req.json() as Record<string, unknown>
    const dir = (body.directory as string) || process.cwd()
    const validatedDir = validatePath(dir, getAllowedRoot())
    if (!validatedDir) {
      return Response.json({ error: "Forbidden" }, { status: 403 })
    }
    const message = body.message as string | undefined

    if (!message || !message.trim()) {
      return Response.json({ error: "message is required" }, { status: 400 })
    }

    try {
      // Stage only tracked files (no untracked)
      await $`git add -u`.cwd(validatedDir).quiet()
      await $`git commit -m ${message.trim()}`.cwd(validatedDir).quiet()
      return Response.json({ success: true })
    } catch (e) {
      console.error("[ExtAPI] pr/commit error:", e)
      return Response.json({ error: String(e) }, { status: 500 })
    }
  }

  // POST /api/ext/pr/push
  // Push current branch to remote. Body: { directory }
  if (path === "/api/ext/pr/push" && method === "POST") {
    const body = await req.json() as Record<string, unknown>
    const dir = (body.directory as string) || process.cwd()
    const validatedDir = validatePath(dir, getAllowedRoot())
    if (!validatedDir) {
      return Response.json({ error: "Forbidden" }, { status: 403 })
    }

    try {
      const branchResult = await $`git rev-parse --abbrev-ref HEAD`.cwd(validatedDir).quiet().nothrow()
      const branch = branchResult.stdout.toString().trim()
      if (!branch || branchResult.exitCode !== 0) {
        return Response.json({ error: "could not determine current branch" }, { status: 400 })
      }
      await $`git push -u origin ${branch}`.cwd(validatedDir).quiet()
      return Response.json({ success: true })
    } catch (e) {
      console.error("[ExtAPI] pr/push error:", e)
      return Response.json({ error: String(e) }, { status: 500 })
    }
  }

  // POST /api/ext/pr/merge
  // Body: { directory, strategy: "merge"|"squash"|"rebase", deleteBranch? }
  if (path === "/api/ext/pr/merge" && method === "POST") {
    const body = await req.json() as Record<string, unknown>
    const dir = (body.directory as string) || process.cwd()
    const validatedDir = validatePath(dir, getAllowedRoot())
    if (!validatedDir) {
      return Response.json({ error: "Forbidden" }, { status: 403 })
    }
    const strategy = body.strategy as string | undefined
    const deleteBranch = body.deleteBranch === true

    const allowed = ["merge", "squash", "rebase"]
    if (strategy && !allowed.includes(strategy)) {
      return Response.json({ error: "invalid merge strategy" }, { status: 400 })
    }

    try {
      const args = ["pr", "merge", "--auto", "--yes"]
      if (!strategy || strategy === "merge") args.push("--merge")
      else if (strategy === "squash") args.push("--squash")
      else args.push("--rebase")
      if (deleteBranch) args.push("--delete-branch")

      await gh(args, validatedDir)
      return Response.json({ success: true })
    } catch (e) {
      console.error("[ExtAPI] pr/merge error:", e)
      return Response.json({ error: String(e) }, { status: 500 })
    }
  }

  // POST /api/ext/pr/ready
  // Mark a draft PR as ready for review. Body: { directory }
  if (path === "/api/ext/pr/ready" && method === "POST") {
    const body = await req.json() as Record<string, unknown>
    const dir = (body.directory as string) || process.cwd()
    const validatedDir = validatePath(dir, getAllowedRoot())
    if (!validatedDir) {
      return Response.json({ error: "Forbidden" }, { status: 403 })
    }

    try {
      await gh(["pr", "ready"], validatedDir)
      return Response.json({ success: true })
    } catch (e) {
      console.error("[ExtAPI] pr/ready error:", e)
      return Response.json({ error: String(e) }, { status: 500 })
    }
  }

  // GET /api/ext/pr/comments?directory=<path>
  // Returns unresolved review threads via gh GraphQL
  if (path === "/api/ext/pr/comments" && method === "GET") {
    const dir = resolveDir(url)
    const validatedDir = validatePath(dir, getAllowedRoot())
    if (!validatedDir) {
      return Response.json({ error: "Forbidden" }, { status: 403 })
    }
    try {
      // Get PR number first
      const prJson = await gh(["pr", "view", "--json", "number,url"], validatedDir)
      const prData = JSON.parse(prJson) as { number: number; url: string }
      const prNumber = prData.number

      // Extract owner/repo from the PR URL
      // e.g. https://github.com/owner/repo/pull/123
      const match = prData.url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\//)
      if (!match) {
        return Response.json({ error: "could not parse repo from PR URL" }, { status: 500 })
      }
      const owner = match[1]
      const repo = match[2]

      // GraphQL query for unresolved review threads
      const query = `
        query($owner: String!, $repo: String!, $number: Int!) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $number) {
              reviewThreads(first: 100) {
                nodes {
                  id
                  isResolved
                  isOutdated
                  path
                  comments(first: 10) {
                    nodes {
                      id
                      body
                      author {
                        login
                        __typename
                      }
                      url
                    }
                  }
                }
              }
            }
          }
        }
      `

      const gqlResult = await gh([
        "api", "graphql",
        "-f", `query=${query}`,
        "-f", `owner=${owner}`,
        "-f", `repo=${repo}`,
        "-F", `number=${prNumber}`,
      ], validatedDir)

      const gqlData = JSON.parse(gqlResult)
      const threads = gqlData?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? []

      // Filter to unresolved, non-outdated threads and shape the response
      const unresolved = threads
        .filter((t: Record<string, unknown>) => !t.isResolved && !t.isOutdated)
        .map((t: Record<string, unknown>) => {
          const comments = (t.comments as { nodes: Array<Record<string, unknown>> }).nodes
          return {
            id: t.id,
            path: t.path,
            comments: comments.map((c) => ({
              id: c.id,
              body: c.body,
              url: c.url,
              author: (c.author as { login: string; __typename: string } | null),
              authorIsBot: (c.author as { __typename: string } | null)?.__typename === "Bot",
            })),
          }
        })

      return Response.json({ threads: unresolved, prNumber, owner, repo })
    } catch (e) {
      console.error("[ExtAPI] pr/comments error:", e)
      return Response.json({ error: String(e) }, { status: 500 })
    }
  }

  // Not an extended endpoint
  return undefined
}
