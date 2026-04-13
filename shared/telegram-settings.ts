import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import { randomUUID } from "node:crypto"
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
  "port",
  "webhookPath",
  "webhookSecret",
  "webhookUrl",
  "sessionStorePath",
  "sessionLinkBase",
] as const

export type TelegramSettingField = (typeof telegramSettingFields)[number]

type TelegramSettingsStore = {
  version: 1
  updatedAt: string
  settings: Partial<Record<TelegramSettingField, string | number>>
}

type ValidationError = {
  field: string
  message: string
}

export type TelegramBridgeSettings = {
  mode: "polling" | "webhook"
  token: string
  openCodeUrl: string
  directory?: string
  sessionCacheMax: number
  sessionCacheTtlMs: number
  notificationDebounceMs: number
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

function parseUrl(value: string, field: string): string {
  try {
    return new URL(value).toString()
  } catch {
    throw new Error(`${field} must be a valid URL`)
  }
}

function normalizeLinkBase(value: string): string {
  const base = value.endsWith("/") ? value.slice(0, -1) : value
  return parseUrl(base, "sessionLinkBase").replace(/\/$/, "")
}

function defaultSessionStorePath() {
  return nodePath.join(os.tmpdir(), "opencode-telegram-sessions.json")
}

function defaultSettingsPath() {
  const home = process.env.HOME || os.homedir()
  const configDir = process.env.OPENCODE_CONFIG_DIR || nodePath.join(home, ".config", "opencode")
  return nodePath.join(configDir, "telegram-settings.json")
}

export function telegramSettingsPath() {
  return env("TELEGRAM_SETTINGS_PATH") || defaultSettingsPath()
}

function envDefaults(): TelegramBridgeSettings {
  const mode = parseMode(env("TELEGRAM_MODE") || "polling")
  const opencodeApiUrl = env("OPENCODE_API_URL")
  const apiUrl = env("API_URL")
  const openCodeUrlValue = opencodeApiUrl || apiUrl || "http://127.0.0.1:4096"
  const webhookPath = env("TELEGRAM_WEBHOOK_PATH") || "/webhook"
  const sessionLinkBase = env("TELEGRAM_SESSION_LINK_BASE")

  return {
    mode,
    token: env("TELEGRAM_BOT_TOKEN"),
    openCodeUrl: parseUrl(openCodeUrlValue, "openCodeUrl"),
    directory: env("OPENCODE_DIRECTORY") || undefined,
    sessionCacheMax: parsePositiveInt(env("TELEGRAM_SESSION_CACHE_MAX") || "", 500),
    sessionCacheTtlMs: parsePositiveInt(env("TELEGRAM_SESSION_CACHE_TTL_MS") || "", 6 * 60 * 60 * 1000),
    notificationDebounceMs: parsePositiveInt(env("TELEGRAM_NOTIFY_DEBOUNCE_MS") || "", 20_000),
    port: parsePort(env("TELEGRAM_BRIDGE_PORT") || "4097"),
    webhookPath: webhookPath.startsWith("/") ? webhookPath : `/${webhookPath}`,
    webhookSecret: env("TELEGRAM_WEBHOOK_SECRET") || undefined,
    webhookUrl: env("TELEGRAM_WEBHOOK_URL") ? parseUrl(env("TELEGRAM_WEBHOOK_URL"), "webhookUrl") : undefined,
    sessionStorePath: env("TELEGRAM_SESSION_STORE_PATH") || defaultSessionStorePath(),
    sessionLinkBase: sessionLinkBase ? normalizeLinkBase(sessionLinkBase) : undefined,
  }
}

function parseStore(text: string): TelegramSettingsStore | undefined {
  if (!text.trim()) return
  const data = JSON.parse(text) as Partial<TelegramSettingsStore>
  if (!data.settings || typeof data.settings !== "object") return
  const settings: Partial<Record<TelegramSettingField, string | number>> = {}
  for (const field of telegramSettingFields) {
    const value = data.settings[field]
    if (typeof value === "string" || typeof value === "number") {
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
  if (!text) return
  return Promise.resolve()
    .then(() => parseStore(text))
    .catch(() => undefined)
}

function applyPersisted(defaults: TelegramBridgeSettings, store: TelegramSettingsStore | undefined): TelegramBridgeSettings {
  if (!store) return defaults
  const s = store.settings

  const openCodeUrl =
    typeof s.openCodeUrl === "string" && s.openCodeUrl.trim()
      ? parseUrl(s.openCodeUrl, "openCodeUrl")
      : defaults.openCodeUrl
  const webhookUrl =
    typeof s.webhookUrl === "string" && s.webhookUrl.trim() ? parseUrl(s.webhookUrl, "webhookUrl") : defaults.webhookUrl
  const sessionLinkBase =
    typeof s.sessionLinkBase === "string" && s.sessionLinkBase.trim()
      ? normalizeLinkBase(s.sessionLinkBase)
      : defaults.sessionLinkBase

  return {
    mode: s.mode === "polling" || s.mode === "webhook" ? s.mode : defaults.mode,
    token: typeof s.token === "string" ? s.token : defaults.token,
    openCodeUrl,
    directory: typeof s.directory === "string" && s.directory.trim() ? s.directory.trim() : defaults.directory,
    sessionCacheMax: typeof s.sessionCacheMax === "number" && s.sessionCacheMax > 0 ? s.sessionCacheMax : defaults.sessionCacheMax,
    sessionCacheTtlMs:
      typeof s.sessionCacheTtlMs === "number" && s.sessionCacheTtlMs > 0 ? s.sessionCacheTtlMs : defaults.sessionCacheTtlMs,
    notificationDebounceMs:
      typeof s.notificationDebounceMs === "number" && s.notificationDebounceMs > 0
        ? s.notificationDebounceMs
        : defaults.notificationDebounceMs,
    port: typeof s.port === "number" && s.port > 0 && s.port <= 65535 ? s.port : defaults.port,
    webhookPath:
      typeof s.webhookPath === "string" && s.webhookPath.trim()
        ? s.webhookPath.startsWith("/")
          ? s.webhookPath
          : `/${s.webhookPath}`
        : defaults.webhookPath,
    webhookSecret: typeof s.webhookSecret === "string" ? s.webhookSecret || undefined : defaults.webhookSecret,
    webhookUrl,
    sessionStorePath:
      typeof s.sessionStorePath === "string" && s.sessionStorePath.trim() ? s.sessionStorePath.trim() : defaults.sessionStorePath,
    sessionLinkBase,
  }
}

function publicSettings(settings: TelegramBridgeSettings, store: TelegramSettingsStore | undefined) {
  const persisted = store?.settings || {}
  return {
    mode: settings.mode,
    tokenConfigured: Boolean(settings.token),
    tokenSource: persisted.token !== undefined ? "persisted" : settings.token ? "env" : "none",
    openCodeUrl: settings.openCodeUrl,
    directory: settings.directory || null,
    sessionCacheMax: settings.sessionCacheMax,
    sessionCacheTtlMs: settings.sessionCacheTtlMs,
    notificationDebounceMs: settings.notificationDebounceMs,
    port: settings.port,
    webhookPath: settings.webhookPath,
    webhookSecretConfigured: Boolean(settings.webhookSecret),
    webhookSecretSource: persisted.webhookSecret !== undefined ? "persisted" : settings.webhookSecret ? "env" : "none",
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
  patch: Partial<Record<TelegramSettingField, string | number | undefined>>
  errors: ValidationError[]
} {
  const raw = readObject(input)
  if (!raw) {
    return { patch: {}, errors: [{ field: "settings", message: "settings object is required" }] }
  }

  const patch: Partial<Record<TelegramSettingField, string | number | undefined>> = {}
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
    if (raw.openCodeUrl === null) {
      patch.openCodeUrl = undefined
    }
    if (typeof raw.openCodeUrl === "string") {
      const valid = pushUrl(errors, "openCodeUrl", raw.openCodeUrl)
      if (valid && raw.openCodeUrl.trim()) {
        patch.openCodeUrl = parseUrl(raw.openCodeUrl.trim(), "openCodeUrl")
      }
    }
    if (raw.openCodeUrl !== null && typeof raw.openCodeUrl !== "string") {
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
    if (raw.sessionStorePath === null) {
      patch.sessionStorePath = undefined
    }
    if (raw.sessionStorePath !== null && (typeof raw.sessionStorePath !== "string" || !raw.sessionStorePath.trim())) {
      errors.push({ field: "sessionStorePath", message: "sessionStorePath must be a non-empty string or null" })
    }
    if (typeof raw.sessionStorePath === "string" && raw.sessionStorePath.trim()) {
      patch.sessionStorePath = raw.sessionStorePath.trim()
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

async function writeSettings(path: string, settings: Partial<Record<TelegramSettingField, string | number>>) {
  await fsp.mkdir(nodePath.dirname(path), { recursive: true })
  const tmpPath = nodePath.join(nodePath.dirname(path), `.${nodePath.basename(path)}.${process.pid}.${randomUUID()}.tmp`)
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
    await fsp.unlink(tmpPath).catch(() => undefined)
    throw error
  })
  await fsp.chmod(path, 0o600).catch(() => undefined)
}

export function loadTelegramBridgeSettings(): TelegramBridgeSettings {
  const defaults = envDefaults()
  const path = telegramSettingsPath()
  if (!fs.existsSync(path)) return defaults
  try {
    const text = fs.readFileSync(path, "utf-8")
    const store = parseStore(text)
    return applyPersisted(defaults, store)
  } catch {
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
      path,
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
  const current = (await readStore(path)) || {
    version: 1,
    updatedAt: new Date().toISOString(),
    settings: {},
  }
  const nextSettings: Partial<Record<TelegramSettingField, string | number>> = { ...current.settings }
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

  await writeSettings(path, nextSettings)
  const next = await readTelegramSettings()
  return {
    ok: true as const,
    changedFields,
    restartRequired: changedFields.length > 0,
    restartRequiredFields: changedFields,
    runtimeReloadableFields: [] as string[],
    ...next,
  }
}
