import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import * as nodePath from "node:path"
import * as os from "node:os"

export const telegramSettingFields = [
  "mode",
  "token",
  "openCodeUrl",
  "directory",
  "sessionCacheMax",
  "sessionCacheTtlMs",
  "notificationDebounceMs",
  "telegramAlarmChannelEnabled",
  "port",
  "webhookPath",
  "webhookSecret",
  "webhookUrl",
  "sessionStorePath",
  "sessionLinkBase",
] as const

export type TelegramSettingField = (typeof telegramSettingFields)[number]

type TelegramSettingValue = string | number | boolean

type TelegramSettingsStore = {
  version: 1
  updatedAt: string
  settings: Partial<Record<TelegramSettingField, TelegramSettingValue>>
}

type ValidationError = {
  field: string
  message: string
}

type TelegramRuntimeState = {
  version: 1
  appliedAt: string
  pid: number
  mode: "polling" | "webhook"
  port: number
  settingsFingerprint: string
}

const updateQueue = new Map<string, Promise<void>>()

export type TelegramBridgeSettings = {
  mode: "polling" | "webhook"
  token: string
  openCodeUrl: string
  directory?: string
  sessionCacheMax: number
  sessionCacheTtlMs: number
  notificationDebounceMs: number
  telegramAlarmChannelEnabled: boolean
  port: number
  webhookPath: string
  webhookSecret?: string
  webhookUrl?: string
  sessionStorePath: string
  sessionLinkBase?: string
}

function env(name: string): string {
  return process.env[name]?.trim() || ""
}

function parseMode(value: string): "polling" | "webhook" {
  const mode = value.trim().toLowerCase()
  if (mode === "polling") return "polling"
  if (mode === "webhook") return "webhook"
  throw new Error(`Invalid TELEGRAM_MODE: ${value}. Expected \"polling\" or \"webhook\"`)
}

function parsePort(value: string): number {
  const n = Number.parseInt(value, 10)
  if (Number.isNaN(n) || n <= 0 || n > 65535) return 4097
  return n
}

function parsePositiveInt(value: string, fallback: number): number {
  const n = Number.parseInt(value, 10)
  if (Number.isNaN(n) || n <= 0) return fallback
  return n
}

function parseUrl(value: string, field: string, source?: string): string {
  const where = source ? ` (${source})` : ""
  if (!URL.canParse(value)) {
    throw new Error(`${field} must be a valid URL${where}`)
  }
  return new URL(value).toString()
}

function normalizeLinkBase(value: string, source?: string): string {
  const base = value.endsWith("/") ? value.slice(0, -1) : value
  return parseUrl(base, "sessionLinkBase", source).replace(/\/$/, "")
}

function parsePersistedUrl(value: unknown, field: "openCodeUrl" | "webhookUrl", fallback: string | undefined): string | undefined {
  if (typeof value !== "string") return fallback
  const trimmed = value.trim()
  if (!trimmed) return fallback
  if (!URL.canParse(trimmed)) return fallback
  return parseUrl(trimmed, field, `persisted ${field}`)
}

function parsePersistedLinkBase(value: unknown, fallback: string | undefined): string | undefined {
  if (typeof value !== "string") return fallback
  const trimmed = value.trim()
  if (!trimmed) return fallback
  const base = trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed
  if (!URL.canParse(base)) return fallback
  return normalizeLinkBase(trimmed, "persisted sessionLinkBase")
}

function defaultSessionStorePath() {
  return nodePath.join(os.tmpdir(), "opencode-telegram-sessions.json")
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error ? String(error.code) : ""
}

function isReplaceConflict(code: string): boolean {
  return code === "EEXIST" || code === "EPERM" || code === "ENOTEMPTY" || code === "EACCES"
}

function backupStamp(entry: string, name: string): number {
  return Number(entry.slice(`${name}.bak.`.length).split(".")[0] || "0")
}

function sortedBackups(entries: string[], name: string): string[] {
  return entries
    .filter((entry) => entry.startsWith(`${name}.bak.`))
    .sort((a, b) => backupStamp(b, name) - backupStamp(a, name))
}

async function applyBackupStore(path: string, backupPath: string): Promise<boolean> {
  const direct = await fsp.rename(backupPath, path).then(
    () => true,
    (error) => {
      if (isReplaceConflict(errorCode(error))) return false
      throw error
    },
  )
  if (direct) return true

  const displaced = `${path}.corrupt.${Date.now()}.${randomUUID()}`
  const moved = await fsp.rename(path, displaced).then(
    () => true,
    (error) => {
      const code = errorCode(error)
      if (code === "ENOENT") return false
      if (isReplaceConflict(code)) return
      throw error
    },
  )
  if (moved === undefined) return false

  const applied = await fsp.rename(backupPath, path).then(
    () => true,
    async (error) => {
      if (moved) {
        await fsp.rename(displaced, path).catch(() => undefined)
      }
      const code = errorCode(error)
      if (isReplaceConflict(code) || code === "ENOENT") return false
      throw error
    },
  )
  if (!applied) return false
  if (moved) {
    await fsp.unlink(displaced).catch(() => undefined)
  }
  return true
}

function applyBackupStoreSync(path: string, backupPath: string): boolean {
  try {
    fs.renameSync(backupPath, path)
    return true
  } catch (error) {
    const code = errorCode(error)
    if (!isReplaceConflict(code)) throw error
  }

  const displaced = `${path}.corrupt.${Date.now()}.${randomUUID()}`
  const moved = (() => {
    try {
      fs.renameSync(path, displaced)
      return true
    } catch (error) {
      const code = errorCode(error)
      if (code === "ENOENT") return false
      if (isReplaceConflict(code)) return
      throw error
    }
  })()
  if (moved === undefined) return false

  try {
    fs.renameSync(backupPath, path)
  } catch (error) {
    if (moved) {
      try {
        fs.renameSync(displaced, path)
      } catch {}
    }
    const code = errorCode(error)
    if (isReplaceConflict(code) || code === "ENOENT") return false
    throw error
  }

  if (moved) {
    try {
      fs.unlinkSync(displaced)
    } catch {}
  }
  return true
}

async function readBackupStore(path: string): Promise<TelegramSettingsStore | undefined> {
  const dir = nodePath.dirname(path)
  const name = nodePath.basename(path)
  const entries = await fsp.readdir(dir).catch((error) => {
    const code = errorCode(error)
    if (code === "ENOENT" || code === "ENOTDIR") return []
    throw error
  })

  for (const entry of sortedBackups(entries, name)) {
    const backupPath = nodePath.join(dir, entry)
    const text = await Bun.file(backupPath).text().catch(() => "")
    if (!text) continue
    const store = await Promise.resolve()
      .then(() => parseStore(text))
      .catch(() => undefined)
    if (!store) continue
    const applied = await applyBackupStore(path, backupPath)
    if (!applied) continue
    return store
  }

  return
}

function readBackupStoreSync(path: string): TelegramSettingsStore | undefined {
  const dir = nodePath.dirname(path)
  const name = nodePath.basename(path)
  const entries = (() => {
    try {
      return fs.readdirSync(dir)
    } catch (error) {
      const code = errorCode(error)
      if (code === "ENOENT" || code === "ENOTDIR") return []
      throw error
    }
  })()

  for (const entry of sortedBackups(entries, name)) {
    const backupPath = nodePath.join(dir, entry)
    const text = (() => {
      try {
        return fs.readFileSync(backupPath, "utf-8")
      } catch {
        return ""
      }
    })()
    if (!text) continue
    const store = (() => {
      try {
        return parseStore(text)
      } catch {
        return
      }
    })()
    if (!store) continue
    const applied = applyBackupStoreSync(path, backupPath)
    if (!applied) continue
    return store
  }

  return
}

function isWithinRoot(path: string, root: string): boolean {
  if (root === nodePath.parse(root).root) return true
  if (path === root) return true
  return path.startsWith(root + nodePath.sep)
}

function allowedSessionStoreRoots() {
  const home = process.env.HOME || os.homedir()
  const configDir = process.env.OPENCODE_CONFIG_DIR || nodePath.join(home, ".config", "opencode")
  const roots = [os.tmpdir(), home, configDir, process.env.OPENCODE_WORKSPACE_ROOT || ""]
  const normalized: string[] = []
  for (const root of roots) {
    if (!root) continue
    const value = nodePath.resolve(root)
    if (normalized.includes(value)) continue
    normalized.push(value)
  }
  return normalized
}

function sanitizeSessionStorePath(value: string): string | undefined {
  const trimmed = value.trim()
  if (!trimmed) return
  if (!nodePath.isAbsolute(trimmed)) return
  const resolved = nodePath.resolve(trimmed)
  for (const root of allowedSessionStoreRoots()) {
    if (isWithinRoot(resolved, root)) return resolved
  }
  return
}

function defaultSettingsPath() {
  const home = process.env.HOME || os.homedir()
  const configDir = process.env.OPENCODE_CONFIG_DIR || nodePath.join(home, ".config", "opencode")
  return nodePath.join(configDir, "telegram-settings.json")
}

function defaultRuntimeStatePath() {
  const home = process.env.HOME || os.homedir()
  const configDir = process.env.OPENCODE_CONFIG_DIR || nodePath.join(home, ".config", "opencode")
  return nodePath.join(configDir, "telegram-runtime-state.json")
}

export function telegramSettingsPath() {
  return env("TELEGRAM_SETTINGS_PATH") || defaultSettingsPath()
}

export function telegramRuntimeStatePath() {
  return env("TELEGRAM_RUNTIME_STATE_PATH") || defaultRuntimeStatePath()
}

export function telegramSettingsFingerprint(settings: Record<string, unknown>) {
  const stable = Object.fromEntries(telegramSettingFields.map((field) => [field, settings[field] ?? null]))
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex")
}

export function readDesiredTelegramSettingsFingerprint() {
  return telegramSettingsFingerprint(loadTelegramBridgeSettings() as unknown as Record<string, unknown>)
}

function parseRuntimeState(text: string): TelegramRuntimeState | undefined {
  if (!text.trim()) return
  const data = JSON.parse(text) as Partial<TelegramRuntimeState>
  if (data.version !== 1) return
  if (typeof data.appliedAt !== "string" || !data.appliedAt.trim()) return
  if (typeof data.pid !== "number" || !Number.isInteger(data.pid) || data.pid <= 0) return
  if (data.mode !== "polling" && data.mode !== "webhook") return
  if (typeof data.port !== "number" || !Number.isInteger(data.port) || data.port <= 0 || data.port > 65535) return
  if (typeof data.settingsFingerprint !== "string" || !data.settingsFingerprint.trim()) return
  return {
    version: 1,
    appliedAt: data.appliedAt,
    pid: data.pid,
    mode: data.mode,
    port: data.port,
    settingsFingerprint: data.settingsFingerprint,
  }
}

export async function readTelegramRuntimeState() {
  const path = telegramRuntimeStatePath()
  const text = await Bun.file(path).text().catch(() => "")
  return Promise.resolve()
    .then(() => parseRuntimeState(text))
    .catch(() => undefined)
}

export async function writeTelegramRuntimeState(config: {
  mode: "polling" | "webhook"
  port: number
} & Record<string, unknown>) {
  const path = telegramRuntimeStatePath()
  const payload: TelegramRuntimeState = {
    version: 1,
    appliedAt: new Date().toISOString(),
    pid: process.pid,
    mode: config.mode,
    port: config.port,
    settingsFingerprint: telegramSettingsFingerprint(config),
  }
  await fsp.mkdir(nodePath.dirname(path), { recursive: true })
  const tmpPath = nodePath.join(nodePath.dirname(path), `.${nodePath.basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  const handle = await fsp.open(tmpPath, "wx", 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, "utf-8")
  } catch (error) {
    await handle.close().catch(() => undefined)
    await fsp.unlink(tmpPath).catch(() => undefined)
    throw error
  }
  await handle.close()
  await fsp.rename(tmpPath, path)
  await fsp.chmod(path, 0o600).catch(() => undefined)
}

function envDefaults(): TelegramBridgeSettings {
  const mode = parseMode(env("TELEGRAM_MODE") || "polling")
  const opencodeApiUrl = env("OPENCODE_API_URL")
  const apiUrl = env("API_URL")
  const openCodeUrlValue = opencodeApiUrl || apiUrl || "http://127.0.0.1:4096"
  const openCodeUrlSource = opencodeApiUrl ? "OPENCODE_API_URL" : apiUrl ? "API_URL" : "default openCodeUrl"
  const webhookPath = env("TELEGRAM_WEBHOOK_PATH") || "/webhook"
  const sessionLinkBase = env("TELEGRAM_SESSION_LINK_BASE")

  return {
    mode,
    token: env("TELEGRAM_BOT_TOKEN"),
    openCodeUrl: parseUrl(openCodeUrlValue, "openCodeUrl", openCodeUrlSource),
    directory: env("OPENCODE_DIRECTORY") || undefined,
    sessionCacheMax: parsePositiveInt(env("TELEGRAM_SESSION_CACHE_MAX") || "", 500),
    sessionCacheTtlMs: parsePositiveInt(env("TELEGRAM_SESSION_CACHE_TTL_MS") || "", 6 * 60 * 60 * 1000),
    notificationDebounceMs: parsePositiveInt(env("TELEGRAM_NOTIFY_DEBOUNCE_MS") || "", 20_000),
    telegramAlarmChannelEnabled: true,
    port: parsePort(env("TELEGRAM_BRIDGE_PORT") || "4097"),
    webhookPath: webhookPath.startsWith("/") ? webhookPath : `/${webhookPath}`,
    webhookSecret: env("TELEGRAM_WEBHOOK_SECRET") || undefined,
    webhookUrl: env("TELEGRAM_WEBHOOK_URL")
      ? parseUrl(env("TELEGRAM_WEBHOOK_URL"), "webhookUrl", "TELEGRAM_WEBHOOK_URL")
      : undefined,
    sessionStorePath: sanitizeSessionStorePath(env("TELEGRAM_SESSION_STORE_PATH")) || defaultSessionStorePath(),
    sessionLinkBase: sessionLinkBase ? normalizeLinkBase(sessionLinkBase, "TELEGRAM_SESSION_LINK_BASE") : undefined,
  }
}

function parseStore(text: string): TelegramSettingsStore | undefined {
  if (!text.trim()) return
  const data = JSON.parse(text) as Partial<TelegramSettingsStore>
  if (!data.settings || typeof data.settings !== "object") return
  const settings: Partial<Record<TelegramSettingField, TelegramSettingValue>> = {}
  for (const field of telegramSettingFields) {
    const value = data.settings[field]
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      settings[field] = value
    }
  }
  return {
    version: 1,
    updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : new Date().toISOString(),
    settings,
  }
}

async function readStore(path: string): Promise<TelegramSettingsStore | undefined> {
  const text = await Bun.file(path).text().catch(() => "")
  const store = await Promise.resolve()
    .then(() => parseStore(text))
    .catch(() => undefined)
  if (store) return store
  return readBackupStore(path)
}

function applyPersisted(defaults: TelegramBridgeSettings, store: TelegramSettingsStore | undefined): TelegramBridgeSettings {
  if (!store) return defaults
  const s = store.settings

  const openCodeUrl = parsePersistedUrl(s.openCodeUrl, "openCodeUrl", defaults.openCodeUrl) || defaults.openCodeUrl
  const webhookUrl = parsePersistedUrl(s.webhookUrl, "webhookUrl", defaults.webhookUrl)
  const sessionLinkBase = parsePersistedLinkBase(s.sessionLinkBase, defaults.sessionLinkBase)

  return {
    mode: s.mode === "polling" || s.mode === "webhook" ? s.mode : defaults.mode,
    token: typeof s.token === "string" && s.token.trim() ? s.token.trim() : defaults.token,
    openCodeUrl,
    directory: typeof s.directory === "string" && s.directory.trim() ? s.directory.trim() : defaults.directory,
    sessionCacheMax: typeof s.sessionCacheMax === "number" && s.sessionCacheMax > 0 ? s.sessionCacheMax : defaults.sessionCacheMax,
    sessionCacheTtlMs:
      typeof s.sessionCacheTtlMs === "number" && s.sessionCacheTtlMs > 0 ? s.sessionCacheTtlMs : defaults.sessionCacheTtlMs,
    notificationDebounceMs:
      typeof s.notificationDebounceMs === "number" && s.notificationDebounceMs > 0
        ? s.notificationDebounceMs
        : defaults.notificationDebounceMs,
    telegramAlarmChannelEnabled:
      typeof s.telegramAlarmChannelEnabled === "boolean"
        ? s.telegramAlarmChannelEnabled
        : defaults.telegramAlarmChannelEnabled,
    port: typeof s.port === "number" && s.port > 0 && s.port <= 65535 ? s.port : defaults.port,
    webhookPath:
      typeof s.webhookPath === "string" && s.webhookPath.trim()
        ? s.webhookPath.startsWith("/")
          ? s.webhookPath
          : `/${s.webhookPath}`
        : defaults.webhookPath,
    webhookSecret:
      typeof s.webhookSecret === "string" && s.webhookSecret.trim() ? s.webhookSecret.trim() : defaults.webhookSecret,
    webhookUrl,
    sessionStorePath:
      typeof s.sessionStorePath === "string" && s.sessionStorePath.trim()
        ? sanitizeSessionStorePath(s.sessionStorePath) || defaults.sessionStorePath
        : defaults.sessionStorePath,
    sessionLinkBase,
  }
}

function publicSettings(settings: TelegramBridgeSettings, store: TelegramSettingsStore | undefined) {
  const persisted = store?.settings || {}
  const persistedToken = typeof persisted.token === "string" && persisted.token.trim()
  const persistedWebhookSecret = typeof persisted.webhookSecret === "string" && persisted.webhookSecret.trim()
  return {
    mode: settings.mode,
    tokenConfigured: Boolean(settings.token),
    tokenSource: persistedToken ? "persisted" : settings.token ? "env" : "none",
    openCodeUrl: settings.openCodeUrl,
    directory: settings.directory || null,
    sessionCacheMax: settings.sessionCacheMax,
    sessionCacheTtlMs: settings.sessionCacheTtlMs,
    notificationDebounceMs: settings.notificationDebounceMs,
    telegramAlarmChannelEnabled: settings.telegramAlarmChannelEnabled,
    port: settings.port,
    webhookPath: settings.webhookPath,
    webhookSecretConfigured: Boolean(settings.webhookSecret),
    webhookSecretSource: persistedWebhookSecret ? "persisted" : settings.webhookSecret ? "env" : "none",
    webhookUrl: settings.webhookUrl || null,
    sessionStorePath: settings.sessionStorePath,
    sessionLinkBase: settings.sessionLinkBase || null,
  }
}

function metadata() {
  const fields = Object.fromEntries(
    telegramSettingFields.map((field) => [field, { runtimeReloadable: false, restartRequired: true }]),
  )
  return {
    fields,
    runtimeReloadableFields: [] as string[],
    restartRequiredFields: [...telegramSettingFields],
  }
}

function queueUpdate<T>(path: string, fn: () => Promise<T>) {
  const tail = (updateQueue.get(path) || Promise.resolve()).catch(() => undefined)
  const run = tail.then(fn)
  const settled = run.then(() => undefined, () => undefined)
  updateQueue.set(path, settled)
  return run.finally(() => {
    if (updateQueue.get(path) !== settled) return
    updateQueue.delete(path)
  })
}

function readObject(input: unknown): Record<string, unknown> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return
  return input as Record<string, unknown>
}

function pushPositive(errors: ValidationError[], field: string, value: unknown) {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    errors.push({ field, message: `${field} must be a positive integer` })
    return
  }
}

function pushUrl(errors: ValidationError[], field: string, value: unknown) {
  if (typeof value !== "string" || !value.trim()) {
    errors.push({ field, message: `${field} must be a valid URL` })
    return false
  }
  try {
    parseUrl(value.trim(), field)
    return true
  } catch {
    errors.push({ field, message: `${field} must be a valid URL` })
    return false
  }
}

function normalizePayload(input: unknown): {
  patch: Partial<Record<TelegramSettingField, TelegramSettingValue | undefined>>
  errors: ValidationError[]
} {
  const raw = readObject(input)
  if (!raw) {
    return { patch: {}, errors: [{ field: "settings", message: "settings object is required" }] }
  }

  const patch: Partial<Record<TelegramSettingField, TelegramSettingValue | undefined>> = {}
  const errors: ValidationError[] = []

  for (const key of Object.keys(raw)) {
    if (!telegramSettingFields.includes(key as TelegramSettingField)) {
      errors.push({ field: key, message: "unknown setting" })
    }
  }

  if ("mode" in raw) {
    if (raw.mode === null) {
      patch.mode = undefined
    }
    if (typeof raw.mode !== "string" && raw.mode !== null) {
      errors.push({ field: "mode", message: "mode must be polling or webhook" })
    }
    if (typeof raw.mode === "string") {
      const mode = raw.mode.trim().toLowerCase()
      if (mode !== "polling" && mode !== "webhook") {
        errors.push({ field: "mode", message: "mode must be polling or webhook" })
      }
      if (mode === "polling" || mode === "webhook") patch.mode = mode
    }
  }

  if ("token" in raw) {
    if (raw.token === null || raw.token === "") patch.token = undefined
    if (typeof raw.token === "string" && raw.token.trim()) patch.token = raw.token.trim()
    if (raw.token !== null && raw.token !== "" && (typeof raw.token !== "string" || !raw.token.trim())) {
      errors.push({ field: "token", message: "token must be a non-empty string or null" })
    }
  }

  if ("openCodeUrl" in raw) {
    if (raw.openCodeUrl === null || raw.openCodeUrl === "") {
      patch.openCodeUrl = undefined
    }
    if (typeof raw.openCodeUrl === "string" && raw.openCodeUrl.trim()) {
      const valid = pushUrl(errors, "openCodeUrl", raw.openCodeUrl)
      if (valid) {
        patch.openCodeUrl = parseUrl(raw.openCodeUrl.trim(), "openCodeUrl")
      }
    }
    if (raw.openCodeUrl !== null && raw.openCodeUrl !== "" && typeof raw.openCodeUrl !== "string") {
      errors.push({ field: "openCodeUrl", message: "openCodeUrl must be a valid URL or null" })
    }
  }

  if ("directory" in raw) {
    if (raw.directory === null || raw.directory === "") patch.directory = undefined
    if (typeof raw.directory === "string" && raw.directory.trim()) patch.directory = raw.directory.trim()
    if (raw.directory !== null && raw.directory !== "" && (typeof raw.directory !== "string" || !raw.directory.trim())) {
      errors.push({ field: "directory", message: "directory must be a non-empty string or null" })
    }
  }

  if ("sessionCacheMax" in raw) {
    if (raw.sessionCacheMax === null) {
      patch.sessionCacheMax = undefined
    }
    if (raw.sessionCacheMax !== null) {
      pushPositive(errors, "sessionCacheMax", raw.sessionCacheMax)
      if (typeof raw.sessionCacheMax === "number" && Number.isInteger(raw.sessionCacheMax) && raw.sessionCacheMax > 0) {
        patch.sessionCacheMax = raw.sessionCacheMax
      }
    }
  }

  if ("sessionCacheTtlMs" in raw) {
    if (raw.sessionCacheTtlMs === null) {
      patch.sessionCacheTtlMs = undefined
    }
    if (raw.sessionCacheTtlMs !== null) {
      pushPositive(errors, "sessionCacheTtlMs", raw.sessionCacheTtlMs)
      if (typeof raw.sessionCacheTtlMs === "number" && Number.isInteger(raw.sessionCacheTtlMs) && raw.sessionCacheTtlMs > 0) {
        patch.sessionCacheTtlMs = raw.sessionCacheTtlMs
      }
    }
  }

  if ("notificationDebounceMs" in raw) {
    if (raw.notificationDebounceMs === null) {
      patch.notificationDebounceMs = undefined
    }
    if (raw.notificationDebounceMs !== null) {
      pushPositive(errors, "notificationDebounceMs", raw.notificationDebounceMs)
      if (
        typeof raw.notificationDebounceMs === "number" &&
        Number.isInteger(raw.notificationDebounceMs) &&
        raw.notificationDebounceMs > 0
      ) {
        patch.notificationDebounceMs = raw.notificationDebounceMs
      }
    }
  }

  if ("telegramAlarmChannelEnabled" in raw) {
    if (raw.telegramAlarmChannelEnabled === null) {
      patch.telegramAlarmChannelEnabled = undefined
    }
    if (typeof raw.telegramAlarmChannelEnabled === "boolean") {
      patch.telegramAlarmChannelEnabled = raw.telegramAlarmChannelEnabled
    }
    if (raw.telegramAlarmChannelEnabled !== null && typeof raw.telegramAlarmChannelEnabled !== "boolean") {
      errors.push({
        field: "telegramAlarmChannelEnabled",
        message: "telegramAlarmChannelEnabled must be a boolean or null",
      })
    }
  }

  if ("port" in raw) {
    if (raw.port === null) {
      patch.port = undefined
    }
    if (raw.port !== null && (typeof raw.port !== "number" || !Number.isInteger(raw.port) || raw.port < 1 || raw.port > 65535)) {
      errors.push({ field: "port", message: "port must be an integer between 1 and 65535" })
    }
    if (typeof raw.port === "number" && Number.isInteger(raw.port) && raw.port >= 1 && raw.port <= 65535) {
      patch.port = raw.port
    }
  }

  if ("webhookPath" in raw) {
    if (raw.webhookPath === null) {
      patch.webhookPath = undefined
    }
    if (raw.webhookPath !== null && (typeof raw.webhookPath !== "string" || !raw.webhookPath.trim())) {
      errors.push({ field: "webhookPath", message: "webhookPath must be a non-empty string or null" })
    }
    if (typeof raw.webhookPath === "string" && raw.webhookPath.trim()) {
      const value = raw.webhookPath.trim()
      patch.webhookPath = value.startsWith("/") ? value : `/${value}`
    }
  }

  if ("webhookSecret" in raw) {
    if (raw.webhookSecret === null || raw.webhookSecret === "") patch.webhookSecret = undefined
    if (typeof raw.webhookSecret === "string" && raw.webhookSecret.trim()) patch.webhookSecret = raw.webhookSecret.trim()
    if (
      raw.webhookSecret !== null &&
      raw.webhookSecret !== "" &&
      (typeof raw.webhookSecret !== "string" || !raw.webhookSecret.trim())
    ) {
      errors.push({ field: "webhookSecret", message: "webhookSecret must be a non-empty string or null" })
    }
  }

  if ("webhookUrl" in raw) {
    if (raw.webhookUrl === null || raw.webhookUrl === "") patch.webhookUrl = undefined
    if (typeof raw.webhookUrl === "string" && raw.webhookUrl.trim()) {
      const valid = pushUrl(errors, "webhookUrl", raw.webhookUrl)
      if (valid) {
        patch.webhookUrl = parseUrl(raw.webhookUrl.trim(), "webhookUrl")
      }
    }
    if (raw.webhookUrl !== null && raw.webhookUrl !== "" && typeof raw.webhookUrl !== "string") {
      errors.push({ field: "webhookUrl", message: "webhookUrl must be a valid URL or null" })
    }
  }

  if ("sessionStorePath" in raw) {
    if (raw.sessionStorePath === null || raw.sessionStorePath === "") {
      patch.sessionStorePath = undefined
    }
    if (raw.sessionStorePath !== null && raw.sessionStorePath !== "" && (typeof raw.sessionStorePath !== "string" || !raw.sessionStorePath.trim())) {
      errors.push({ field: "sessionStorePath", message: "sessionStorePath must be a non-empty string or null" })
    }
    if (typeof raw.sessionStorePath === "string" && raw.sessionStorePath.trim()) {
      const next = sanitizeSessionStorePath(raw.sessionStorePath)
      if (!next) {
        errors.push({
          field: "sessionStorePath",
          message:
            "sessionStorePath must be an absolute path within OPENCODE_WORKSPACE_ROOT, HOME, OPENCODE_CONFIG_DIR, or the system temp directory",
        })
      }
      if (next) patch.sessionStorePath = next
    }
  }

  if ("sessionLinkBase" in raw) {
    if (raw.sessionLinkBase === null || raw.sessionLinkBase === "") patch.sessionLinkBase = undefined
    if (typeof raw.sessionLinkBase === "string" && raw.sessionLinkBase.trim()) {
      const valid = pushUrl(errors, "sessionLinkBase", raw.sessionLinkBase)
      if (valid) {
        patch.sessionLinkBase = normalizeLinkBase(raw.sessionLinkBase.trim())
      }
    }
    if (raw.sessionLinkBase !== null && raw.sessionLinkBase !== "" && typeof raw.sessionLinkBase !== "string") {
      errors.push({ field: "sessionLinkBase", message: "sessionLinkBase must be a valid URL or null" })
    }
  }

  return { patch, errors }
}

async function writeSettings(path: string, settings: Partial<Record<TelegramSettingField, TelegramSettingValue>>) {
  await fsp.mkdir(nodePath.dirname(path), { recursive: true })
  const tmpPath = nodePath.join(nodePath.dirname(path), `.${nodePath.basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  const backupPath = `${path}.bak.${Date.now()}.${randomUUID()}`
  const payload: TelegramSettingsStore = {
    version: 1,
    updatedAt: new Date().toISOString(),
    settings,
  }
  const handle = await fsp.open(tmpPath, "wx", 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, "utf-8")
  } catch (error) {
    await handle.close().catch(() => undefined)
    await fsp.unlink(tmpPath).catch(() => undefined)
    throw error
  }
  await handle.close()
  await fsp.rename(tmpPath, path).catch(async (error) => {
    const code = errorCode(error)
    if (!isReplaceConflict(code)) {
      await fsp.unlink(tmpPath).catch(() => undefined)
      throw error
    }

    const moved = await fsp.rename(path, backupPath).then(
      () => true,
      async (backupError) => {
        if (errorCode(backupError) === "ENOENT") return false
        await fsp.unlink(tmpPath).catch(() => undefined)
        throw backupError
      },
    )

    await fsp.rename(tmpPath, path).catch(async (replaceError) => {
      if (moved) {
        await fsp.rename(backupPath, path).catch(() => undefined)
      }
      await fsp.unlink(tmpPath).catch(() => undefined)
      throw replaceError
    })

    if (moved) {
      await fsp.unlink(backupPath).catch(() => undefined)
    }
  })
  await fsp.chmod(path, 0o600).catch(() => undefined)
}

export function loadTelegramBridgeSettings(): TelegramBridgeSettings {
  const defaults = envDefaults()
  const path = telegramSettingsPath()
  if (!fs.existsSync(path)) {
    const recovered = readBackupStoreSync(path)
    if (!recovered) return defaults
    return applyPersisted(defaults, recovered)
  }
  try {
    const text = fs.readFileSync(path, "utf-8")
    const store = parseStore(text)
    return applyPersisted(defaults, store)
  } catch {
    const recovered = readBackupStoreSync(path)
    if (recovered) return applyPersisted(defaults, recovered)
    return defaults
  }
}

export async function readTelegramSettings() {
  const path = telegramSettingsPath()
  const defaults = envDefaults()
  const store = await readStore(path)
  const settings = Promise.resolve()
    .then(() => applyPersisted(defaults, store))
    .catch(() => defaults)
  const resolved = await settings
  return {
    settings: publicSettings(resolved, store),
    storage: {
      persisted: Boolean(store),
      updatedAt: store?.updatedAt || null,
    },
    metadata: metadata(),
  }
}

export async function updateTelegramSettings(input: unknown) {
  const normalized = normalizePayload(input)
  if (normalized.errors.length) {
    return { ok: false as const, errors: normalized.errors }
  }

  const path = telegramSettingsPath()
  return queueUpdate(path, async () => {
    const current = (await readStore(path)) || {
      version: 1,
      updatedAt: new Date().toISOString(),
      settings: {},
    }
    const nextSettings: Partial<Record<TelegramSettingField, TelegramSettingValue>> = { ...current.settings }
    const changedFields: string[] = []

    for (const field of telegramSettingFields) {
      if (!(field in normalized.patch)) continue
      const next = normalized.patch[field]
      const prev = nextSettings[field]
      if (next === undefined) {
        if (prev === undefined) continue
        delete nextSettings[field]
        changedFields.push(field)
        continue
      }
      if (prev === next) continue
      nextSettings[field] = next
      changedFields.push(field)
    }

    if (changedFields.length === 0) {
      const next = await readTelegramSettings()
      return {
        ok: true as const,
        changedFields,
        restartRequired: false,
        restartRequiredFields: changedFields,
        runtimeReloadableFields: [] as string[],
        ...next,
      }
    }

    await writeSettings(path, nextSettings)
    const next = await readTelegramSettings()
    return {
      ok: true as const,
      changedFields,
      restartRequired: true,
      restartRequiredFields: changedFields,
      runtimeReloadableFields: [] as string[],
      ...next,
    }
  })
}
