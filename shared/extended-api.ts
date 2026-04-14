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
import {
  readDesiredTelegramSettingsFingerprint,
  readTelegramRuntimeState,
  readTelegramSettings,
  updateTelegramSettings,
} from "./telegram-settings"
import { createTelegramSessionStore, type TelegramSessionStore } from "./telegram-session-store"

const telegramSessionStores = new Map<string, TelegramSessionStore>()

function telegramSessionStore(sessionStorePath: string) {
  const cached = telegramSessionStores.get(sessionStorePath)
  if (cached) return cached
  const next = createTelegramSessionStore(sessionStorePath)
  telegramSessionStores.set(sessionStorePath, next)
  return next
}

type TelegramBridgeHealthResponse = {
  status?: "healthy" | "degraded"
  checkedAt?: string
  process?: {
    status?: "up" | "down"
    pid?: number
    uptimeSec?: number
    mode?: "polling" | "webhook"
  }
  config?: {
    status?: "ok"
    tokenConfigured?: boolean
    webhookSecretConfigured?: boolean
    openCodeUrlConfigured?: boolean
    sessionStorePathConfigured?: boolean
    directoryConfigured?: boolean
    mode?: "polling" | "webhook"
  }
  dependencies?: {
    telegramApi?: { status?: "ok" | "error" | "unknown"; message?: string }
    openCodeApi?: { status?: "ok" | "error" | "unknown"; message?: string }
  }
}

type TelegramHealthMessage = {
  type: "config" | "runtime" | "dependency"
  text: string
}

function bridgeHealthStatus(value: unknown): "healthy" | "degraded" {
  if (value === "healthy") return "healthy"
  return "degraded"
}

function bridgeProcess(raw: TelegramBridgeHealthResponse["process"] | undefined) {
  return {
    status: raw?.status === "down" ? "down" : "up",
    pid: typeof raw?.pid === "number" ? raw.pid : undefined,
    uptimeSec: typeof raw?.uptimeSec === "number" ? raw.uptimeSec : undefined,
    mode: raw?.mode === "webhook" ? "webhook" : raw?.mode === "polling" ? "polling" : undefined,
  }
}

function bridgeConfig(raw: TelegramBridgeHealthResponse["config"] | undefined, settings: Awaited<ReturnType<typeof readTelegramSettings>>["settings"]) {
  return {
    status: raw?.status === "ok" ? "ok" : "error",
    mode: raw?.mode === "webhook" ? "webhook" : raw?.mode === "polling" ? "polling" : settings.mode,
    tokenConfigured: typeof raw?.tokenConfigured === "boolean" ? raw.tokenConfigured : settings.tokenConfigured,
    webhookSecretConfigured: typeof raw?.webhookSecretConfigured === "boolean" ? raw.webhookSecretConfigured : settings.webhookSecretConfigured,
    openCodeUrlConfigured: typeof raw?.openCodeUrlConfigured === "boolean" ? raw.openCodeUrlConfigured : Boolean(settings.openCodeUrl),
    sessionStorePathConfigured: typeof raw?.sessionStorePathConfigured === "boolean" ? raw.sessionStorePathConfigured : Boolean(settings.sessionStorePath),
    directoryConfigured: typeof raw?.directoryConfigured === "boolean" ? raw.directoryConfigured : Boolean(settings.directory),
  }
}

function bridgeDependency(raw: { status?: "ok" | "error" | "unknown"; message?: string } | undefined, missing: string) {
  return {
    status: raw?.status === "ok" || raw?.status === "error" || raw?.status === "unknown" ? raw.status : "unknown",
    message: typeof raw?.message === "string" && raw.message.trim().length > 0 ? raw.message : missing,
  }
}

function bridgeMessages(dependencies: {
  telegramApi: { status: "ok" | "error" | "unknown"; message: string }
  openCodeApi: { status: "ok" | "error" | "unknown"; message: string }
}): TelegramHealthMessage[] {
  const messages: TelegramHealthMessage[] = []
  if (dependencies.telegramApi.status === "error") {
    messages.push({ type: "dependency", text: dependencies.telegramApi.message || "Telegram API check failed" })
  }
  if (dependencies.openCodeApi.status === "error") {
    messages.push({ type: "dependency", text: dependencies.openCodeApi.message || "OpenCode API check failed" })
  }
  return messages
}

type TelegramRestartStatus = {
  status: "applied" | "pending_restart"
  pendingRestart: boolean
  desiredSettingsFingerprint: string
  appliedSettingsFingerprint: string | null
  appliedAt: string | null
  pid: number | null
  mode: "polling" | "webhook" | null
  port: number | null
}

type TelegramSettingsResponse = Awaited<ReturnType<typeof readTelegramSettings>>

function defaultTelegramBridgePort() {
  return 4097
}

function telegramBridgePortFromSettings(settings: TelegramSettingsResponse | null) {
  return typeof settings?.settings?.port === "number" ? settings.settings.port : defaultTelegramBridgePort()
}

function restartProbePort(status: TelegramRestartStatus | null, settings: TelegramSettingsResponse | null) {
  if (typeof status?.port === "number") return status.port
  return telegramBridgePortFromSettings(settings)
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function restartAuthorized(req: Request) {
  const token = (process.env.TELEGRAM_BRIDGE_RESTART_TOKEN || "").trim()
  if (token) {
    const header = (req.headers.get("authorization") || "").trim()
    return header === `Bearer ${token}`
  }
  const unsafe = (process.env.TELEGRAM_BRIDGE_ALLOW_UNAUTH_RESTART || "").trim().toLowerCase()
  return unsafe === "1" || unsafe === "true" || unsafe === "yes" || unsafe === "on"
}

function isDebugRestartResponseEnabled() {
  const value = (process.env.TELEGRAM_BRIDGE_RESTART_DEBUG || "").trim().toLowerCase()
  return value === "1" || value === "true" || value === "yes" || value === "on"
}

function parseRestartArgv(value: string) {
  try {
    const parsed = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
  } catch {
    return []
  }
}

function restartCommand() {
  const customArgvRaw = (process.env.TELEGRAM_BRIDGE_RESTART_COMMAND_ARGV || "").trim()
  const customArgv = customArgvRaw ? parseRestartArgv(customArgvRaw) : []
  if (customArgv.length > 0) {
    return { cmd: customArgv, reason: "custom argv command" }
  }
  const custom = (process.env.TELEGRAM_BRIDGE_RESTART_COMMAND || "").trim()
  if (custom) {
    if (process.platform === "win32") {
      return { cmd: ["cmd.exe", "/d", "/s", "/c", custom], reason: "custom shell command" }
    }
    return { cmd: ["sh", "-lc", custom], reason: "custom shell command" }
  }
  const servicePath = (process.env.TELEGRAM_BRIDGE_S6_SERVICE_PATH || "/run/service/telegram-bridge").trim() || "/run/service/telegram-bridge"
  return { cmd: ["s6-svc", "-r", servicePath], reason: "s6 service restart" }
}

async function runRestartCommand(debug: boolean) {
  const timeout = Number.parseInt(process.env.TELEGRAM_BRIDGE_RESTART_TIMEOUT_MS || "15000", 10)
  const timeoutMs = Number.isFinite(timeout) && timeout > 0 ? timeout : 15_000
  const info = restartCommand()
  const p = await Promise.resolve()
    .then(() =>
      Bun.spawn({
        cmd: info.cmd,
        stdout: debug ? "pipe" : "inherit",
        stderr: debug ? "pipe" : "inherit",
      }),
    )
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      return {
        ...info,
        timedOut: false,
        code: null,
        stdout: "",
        stderr: message,
        spawnFailed: true,
        ok: false,
      }
    })
  if (!("exited" in p)) {
    return p
  }
  const done = await Promise.race([
    p.exited.then((code) => ({ code, timedOut: false as const })),
    wait(timeoutMs).then(() => ({ code: null, timedOut: true as const })),
  ])
  if (done.timedOut) {
    p.kill()
  }
  const stdout = debug && p.stdout
    ? await new Response(p.stdout).text().catch(() => "")
    : ""
  const stderr = debug && p.stderr
    ? await new Response(p.stderr).text().catch(() => "")
    : ""
  return {
    ...info,
    timedOut: done.timedOut,
    code: done.code,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    spawnFailed: false,
    ok: !done.timedOut && done.code === 0,
  }
}

async function readTelegramRestartStatus(): Promise<TelegramRestartStatus> {
  const desiredSettingsFingerprint = readDesiredTelegramSettingsFingerprint()
  const runtime = await readTelegramRuntimeState()
  const pendingRestart = runtime?.settingsFingerprint !== desiredSettingsFingerprint
  return {
    status: pendingRestart ? "pending_restart" : "applied",
    pendingRestart,
    desiredSettingsFingerprint,
    appliedSettingsFingerprint: runtime?.settingsFingerprint || null,
    appliedAt: runtime?.appliedAt || null,
    pid: runtime?.pid || null,
    mode: runtime?.mode || null,
    port: runtime?.port || null,
  }
}

async function waitForBridgeApply() {
  const timeout = Number.parseInt(process.env.TELEGRAM_BRIDGE_APPLY_TIMEOUT_MS || "45000", 10)
  const timeoutMs = Number.isFinite(timeout) && timeout > 0 ? timeout : 45_000
  const pollMs = 1500
  const started = Date.now()
  const readStatus = () =>
    readTelegramRestartStatus()
      .then((status) => ({ status, error: null as string | null }))
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        console.error("[ExtAPI] telegram restart status poll error", error)
        return { status: null, error: message }
      })
  while (Date.now() - started < timeoutMs) {
    const read = await readStatus()
    const status = read.status
    const settings = await readTelegramSettings().catch(() => null)
    const port = restartProbePort(status, settings)
    const health = await queryTelegramBridgeHealth(port)
    if (status && !status.pendingRestart && health?.process?.status === "up") {
      return { ok: true as const, status, health }
    }
    await wait(pollMs)
  }
  const read = await readStatus()
  const status = read.status
  const settings = await readTelegramSettings().catch(() => null)
  const port = restartProbePort(status, settings)
  const health = await queryTelegramBridgeHealth(port)
  return { ok: false as const, status, health, error: read.error }
}

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

async function queryTelegramBridgeHealth(port: number): Promise<TelegramBridgeHealthResponse | undefined> {
  const timeoutMs = 7_000
  const url = `http://127.0.0.1:${port}/health`
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
  }).catch(() => undefined)
  if (!res?.ok) return
  return res.json().catch(() => undefined)
}

interface StoredPrompt {
  id: string
  title: string
  text: string
  createdAt: number
  scope?: "global" | "project"
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

function parsePromptValue(item: unknown, scope: "global" | "project"): StoredPrompt | null {
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
  const itemScope = row.scope === "global" || row.scope === "project" ? row.scope : scope
  return { id, title, text, createdAt, scope: itemScope }
}

function parsePromptList(raw: string, scope: "global" | "project"): StoredPrompt[] {
  const parsed = JSON.parse(raw)
  const nestedPrompts = parsed && typeof parsed === "object" ? (parsed as { prompts?: unknown }).prompts : undefined
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object"
      ? Array.isArray(nestedPrompts)
        ? nestedPrompts
        : nestedPrompts && typeof nestedPrompts === "object" && Array.isArray((nestedPrompts as Record<string, unknown>)[scope])
          ? ((nestedPrompts as Record<string, unknown>)[scope] as unknown[])
          : Array.isArray((parsed as Record<string, unknown>)[scope])
            ? ((parsed as Record<string, unknown>)[scope] as unknown[])
            : null
      : []
  if (list === null) {
    throw new Error(`invalid saved prompts format for ${scope}: expected array, prompts array, prompts.${scope}, or ${scope} array`)
  }
  const prompts: StoredPrompt[] = []
  for (let i = 0; i < list.length; i++) {
    const prompt = parsePromptValue(list[i], scope)
    if (!prompt) {
      console.warn(`[ExtAPI] skipped invalid saved prompt at ${scope}[${i}]`)
      continue
    }
    prompts.push(prompt)
  }
  return prompts
}

async function readPromptFile(path: string, scope: "global" | "project"): Promise<StoredPrompt[]> {
  try {
    const content = await fs.promises.readFile(path, "utf-8")
    return parsePromptList(content, scope)
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
    const prompts = await readPromptFile(path, scope)
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

  if (path === "/api/ext/telegram/session-alarm" && method === "GET") {
    const sessionId = (url.searchParams.get("sessionId") || "").trim()
    if (!sessionId) {
      return Response.json({ error: "sessionId query parameter is required" }, { status: 400 })
    }
    const settings = await readTelegramSettings().catch((error) => {
      console.error("[ExtAPI] telegram settings read error", error)
      return null
    })
    if (!settings) {
      return Response.json({ error: "failed to read telegram settings" }, { status: 500 })
    }
    const store = telegramSessionStore(settings.settings.sessionStorePath)
    if (!store.sessionAlarmGet) {
      return Response.json(
        {
          error: "not_implemented",
          message: "telegram session alarm read is not supported by the configured session store",
        },
        { status: 501 },
      )
    }
    const enabled = await store.sessionAlarmGet(sessionId).catch((error) => {
      console.error("[ExtAPI] telegram session alarm read error", error)
      return undefined
    })
    if (enabled === undefined) {
      return Response.json({ error: "failed to read telegram session alarm" }, { status: 500 })
    }
    return Response.json({ sessionId, enabled: enabled === true })
  }

  if (path === "/api/ext/telegram/session-alarm" && method === "PUT") {
    const body = await req.json().catch(() => null)
    const payload = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null
    const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId.trim() : ""
    const enabled = payload?.enabled
    if (!sessionId) {
      return Response.json({ error: "sessionId is required" }, { status: 400 })
    }
    if (typeof enabled !== "boolean") {
      return Response.json({ error: "enabled must be a boolean" }, { status: 400 })
    }
    const settings = await readTelegramSettings().catch((error) => {
      console.error("[ExtAPI] telegram settings read error", error)
      return null
    })
    if (!settings) {
      return Response.json({ error: "failed to read telegram settings" }, { status: 500 })
    }
    const store = telegramSessionStore(settings.settings.sessionStorePath)
    if (!store.sessionAlarmSet) {
      return Response.json(
        {
          error: "not_implemented",
          message: "telegram session alarm update is not supported by the configured session store",
        },
        { status: 501 },
      )
    }
    const ok = await store.sessionAlarmSet(sessionId, enabled).then(
      () => true,
      (error) => {
        console.error("[ExtAPI] telegram session alarm write error", error)
        return false
      },
    )
    if (ok === false) {
      return Response.json({ error: "failed to update telegram session alarm" }, { status: 500 })
    }
    return Response.json({ sessionId, enabled })
  }

  if (path === "/api/ext/telegram/restart" && method === "GET") {
    const status = await readTelegramRestartStatus().catch((error) => {
      console.error("[ExtAPI] telegram restart status read error", error)
      return null
    })
    if (!status) {
      return Response.json({ error: "failed to read telegram restart status" }, { status: 500 })
    }

    const settings = await readTelegramSettings().catch(() => null)
    const port = restartProbePort(status, settings)
    const health = await queryTelegramBridgeHealth(port)
    const bridgeReachable = Boolean(health)
    const bridgeHealthy = health?.status === "healthy"
    return Response.json({
      ...status,
      bridgeReachable,
      bridgeHealthy,
      checkedAt: new Date().toISOString(),
    })
  }

  if (path === "/api/ext/telegram/restart" && method === "POST") {
    if (!restartAuthorized(req)) {
      return Response.json(
        {
          error: "forbidden",
          message: "telegram restart is not authorized",
          hint: "Set TELEGRAM_BRIDGE_RESTART_TOKEN and use Authorization: Bearer <token>",
        },
        { status: 403 },
      )
    }
    const before = await readTelegramRestartStatus().catch((error) => {
      console.error("[ExtAPI] telegram restart status read error", error)
      return null
    })
    if (!before) {
      return Response.json({ error: "failed to read telegram restart status" }, { status: 500 })
    }
    if (!before.pendingRestart) {
      return Response.json({
        ok: true,
        restarted: false,
        status: before,
        message: "Telegram bridge is already using applied settings",
      })
    }

    const debug = isDebugRestartResponseEnabled()
    const run = await runRestartCommand(debug)
    if (!run.ok) {
      const reason = run.spawnFailed
        ? "restart command failed to start"
        : run.timedOut
          ? `restart command timed out after ${process.env.TELEGRAM_BRIDGE_RESTART_TIMEOUT_MS || "15000"}ms`
          : `restart command failed with exit code ${run.code ?? "unknown"}`
      return Response.json(
        {
          error: "restart_failed",
          message: reason,
          hint: "Verify telegram-bridge service supervision and restart command configuration",
          commandReason: run.reason,
          ...(debug
            ? {
                debug: {
                  code: run.code,
                  timedOut: run.timedOut,
                  spawnFailed: run.spawnFailed,
                },
              }
            : {}),
        },
        { status: 500 },
      )
    }

    const applied = await waitForBridgeApply()
    if (!applied.ok) {
      return Response.json(
        {
          error: "restart_unhealthy",
          message: "Telegram bridge restart triggered but service did not become healthy in time",
          hint: "Check telegram-bridge logs and /api/ext/telegram/health for runtime failures",
          commandReason: run.reason,
          status: applied.status,
          health: applied.health || null,
          ...(debug
            ? {
                debug: {
                  code: run.code,
                  timedOut: run.timedOut,
                },
              }
            : {}),
        },
        { status: 502 },
      )
    }

    return Response.json({
      ok: true,
      restarted: true,
      status: applied.status,
      health: applied.health,
      checkedAt: new Date().toISOString(),
    })
  }

  if (path === "/api/ext/telegram/health" && method === "GET") {
    const settings = await readTelegramSettings().catch((error) => {
      console.error("[ExtAPI] telegram health settings read error", error)
      return null
    })
    if (!settings) {
      return Response.json({ error: "failed to read telegram settings" }, { status: 500 })
    }

    const port = typeof settings.settings.port === "number" ? settings.settings.port : 4097
    const bridge = await queryTelegramBridgeHealth(port)

    if (bridge) {
      const dependencies = {
        telegramApi: bridgeDependency(bridge.dependencies?.telegramApi, "Telegram API check unavailable"),
        openCodeApi: bridgeDependency(bridge.dependencies?.openCodeApi, "OpenCode API check unavailable"),
      }
      return Response.json({
        status: bridgeHealthStatus(bridge.status),
        checkedAt: typeof bridge.checkedAt === "string" ? bridge.checkedAt : new Date().toISOString(),
        bridgeReachable: true,
        process: bridgeProcess(bridge.process),
        config: bridgeConfig(bridge.config, settings.settings),
        dependencies,
        messages: bridgeMessages(dependencies),
      })
    }

    const configError = !settings.settings.tokenConfigured
      ? "Telegram bot token is not configured"
      : "Telegram bridge process is not reachable"
    const messageType = !settings.settings.tokenConfigured ? "config" : "runtime"
    return Response.json({
      status: "down",
      checkedAt: new Date().toISOString(),
      bridgeReachable: false,
      process: { status: "down" },
      config: {
        status: !settings.settings.tokenConfigured ? "error" : "ok",
        mode: settings.settings.mode,
        tokenConfigured: settings.settings.tokenConfigured,
        webhookSecretConfigured: settings.settings.webhookSecretConfigured,
        openCodeUrlConfigured: Boolean(settings.settings.openCodeUrl),
        sessionStorePathConfigured: Boolean(settings.settings.sessionStorePath),
        directoryConfigured: Boolean(settings.settings.directory),
      },
      dependencies: {
        telegramApi: { status: "unknown", message: "Bridge is down" },
        openCodeApi: { status: "unknown", message: "Bridge is down" },
      },
      messages: [{ type: messageType, text: configError }],
    })
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

    const body = (await req.json().catch(() => null)) as unknown
    const payload = body && typeof body === "object" ? (body as Record<string, unknown>) : null
    const global = payload && Array.isArray(payload.global) ? payload.global : null
    const project = payload && Array.isArray(payload.project) ? payload.project : null
    if (!global || !project) {
      return Response.json({ error: "global and project arrays are required" }, { status: 400 })
    }

    const configDir = getConfigDir()
    const globalPath = nodePath.join(configDir, "saved-prompts.json")
    const projectPath = validatedDir ? nodePath.join(validatedDir, ".opencode", "saved-prompts.json") : null
    const parsedGlobal = global.map((item) => parsePromptValue(item, "global"))
    const badGlobal = parsedGlobal.findIndex((item) => item === null)
    if (badGlobal !== -1) {
      return Response.json({ error: `global[${badGlobal}] is invalid` }, { status: 400 })
    }
    const parsedProject = project.map((item) => parsePromptValue(item, "project"))
    const badProject = parsedProject.findIndex((item) => item === null)
    if (badProject !== -1) {
      return Response.json({ error: `project[${badProject}] is invalid` }, { status: 400 })
    }
    const nextGlobal = parsedGlobal as StoredPrompt[]
    const nextProject = parsedProject as StoredPrompt[]
    if (project.length > 0 && !validatedDir) {
      return Response.json({ error: "directory is required for project prompts" }, { status: 400 })
    }

    try {
      await writePromptFile(globalPath, nextGlobal.map((p) => sanitizePrompt(p, "global")))
      if (projectPath) {
        await writePromptFile(projectPath, nextProject.map((p) => sanitizePrompt(p, "project")))
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
