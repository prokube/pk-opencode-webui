export type TelegramMode = "polling" | "webhook"

export type TelegramPublicSettings = {
  mode: TelegramMode
  tokenConfigured: boolean
  tokenSource: "persisted" | "env" | "none"
  openCodeUrl: string
  directory: string | null
  sessionCacheMax: number
  sessionCacheTtlMs: number
  notificationDebounceMs: number
  telegramAlarmChannelEnabled: boolean
  port: number
  webhookPath: string
  webhookSecretConfigured: boolean
  webhookSecretSource: "persisted" | "env" | "none"
  webhookUrl: string | null
  sessionStorePath: string
  sessionLinkBase: string | null
}

export type TelegramMetadata = {
  fields: Record<string, TelegramFieldMetadata>
  runtimeReloadableFields: string[]
  restartRequiredFields: string[]
}

export type TelegramFieldMetadata = {
  runtimeReloadable: boolean
  restartRequired: boolean
}

export type TelegramStorage = {
  persisted: boolean
  updatedAt: string | null
}

export type TelegramSettingsResponse = {
  settings: TelegramPublicSettings
  storage: TelegramStorage
  metadata: TelegramMetadata
}

export type TelegramHealthResponse = {
  status: "healthy" | "degraded" | "down"
  checkedAt: string
  bridgeReachable: boolean
  process: {
    status: "up" | "down"
    pid?: number
    uptimeSec?: number
    mode?: TelegramMode
  }
  config: {
    status: "ok" | "error"
    mode: TelegramMode
    tokenConfigured: boolean
    webhookSecretConfigured: boolean
    openCodeUrlConfigured: boolean
    sessionStorePathConfigured: boolean
    directoryConfigured: boolean
  }
  dependencies: {
    telegramApi: {
      status: "ok" | "error" | "unknown"
      message: string
    }
    openCodeApi: {
      status: "ok" | "error" | "unknown"
      message: string
    }
  }
  messages: Array<{
    type: "config" | "runtime" | "dependency"
    text: string
  }>
}

export function telegramHealthLabel(status: TelegramHealthResponse["status"]): string {
  if (status === "healthy") return "Healthy"
  if (status === "degraded") return "Degraded"
  return "Down"
}

export function telegramHealthHasConfigError(health: TelegramHealthResponse): boolean {
  return health.messages.some((item) => item.type === "config")
}

export type TelegramValidationError = {
  field: string
  message: string
}

export type TelegramUpdateSuccess = TelegramSettingsResponse & {
  ok: true
  changedFields: string[]
  restartRequired: boolean
  restartRequiredFields: string[]
}

export type TelegramUpdateFailure = {
  ok?: false
  error?: string
  errors?: TelegramValidationError[]
}

export type TelegramForm = {
  mode: TelegramMode
  openCodeUrl: string
  directory: string
  sessionCacheMax: string
  sessionCacheTtlMs: string
  notificationDebounceMs: string
  port: string
  webhookPath: string
  webhookUrl: string
  sessionStorePath: string
  sessionLinkBase: string
  tokenMode: "unchanged" | "set" | "clear"
  token: string
  webhookSecretMode: "unchanged" | "set" | "clear"
  webhookSecret: string
}

function toNumber(value: string): number | undefined {
  const trimmed = value.trim()
  if (!trimmed) return
  const n = Number(trimmed)
  if (!Number.isInteger(n)) return
  return n
}

function isUrl(value: string): boolean {
  try {
    new URL(value)
    return true
  } catch {
    return false
  }
}

function asNullable(value: string): string | null {
  return value.trim() ? value.trim() : null
}

function normalizeWebhookPath(value: string): string | null {
  const path = asNullable(value)
  if (!path) return null
  if (path.startsWith("/")) return path
  return `/${path}`
}

export function normalizeWebhookPathInput(value: string): string {
  return normalizeWebhookPath(value) || ""
}

function addStringPatch(patch: Record<string, string | number | null>, key: string, next: string, prev: string) {
  const nextValue = asNullable(next)
  const prevValue = asNullable(prev)
  if (nextValue === prevValue) return
  patch[key] = nextValue
}

function addNumberPatch(patch: Record<string, string | number | null>, key: string, next: string, prev: string) {
  const nextValue = toNumber(next)
  const prevValue = toNumber(prev)
  if (nextValue === prevValue) return
  patch[key] = nextValue ?? null
}

function addWebhookPathPatch(patch: Record<string, string | number | null>, next: string, prev: string) {
  const nextValue = normalizeWebhookPath(next)
  const prevValue = normalizeWebhookPath(prev)
  if (nextValue === prevValue) return
  patch.webhookPath = nextValue
}

export function createTelegramForm(settings: TelegramPublicSettings): TelegramForm {
  return {
    mode: settings.mode,
    openCodeUrl: settings.openCodeUrl,
    directory: settings.directory || "",
    sessionCacheMax: String(settings.sessionCacheMax),
    sessionCacheTtlMs: String(settings.sessionCacheTtlMs),
    notificationDebounceMs: String(settings.notificationDebounceMs),
    port: String(settings.port),
    webhookPath: settings.webhookPath,
    webhookUrl: settings.webhookUrl || "",
    sessionStorePath: settings.sessionStorePath,
    sessionLinkBase: settings.sessionLinkBase || "",
    tokenMode: "unchanged",
    token: "",
    webhookSecretMode: "unchanged",
    webhookSecret: "",
  }
}

export function validateTelegramForm(form: TelegramForm): Record<string, string> {
  const errors: Record<string, string> = {}

  const openCodeUrl = form.openCodeUrl.trim()
  if (openCodeUrl && !isUrl(openCodeUrl)) errors.openCodeUrl = "Enter a valid URL"
  if (form.webhookUrl.trim() && !isUrl(form.webhookUrl.trim())) errors.webhookUrl = "Enter a valid URL"
  if (form.sessionLinkBase.trim() && !isUrl(form.sessionLinkBase.trim())) errors.sessionLinkBase = "Enter a valid URL"

  const sessionCacheMaxRaw = form.sessionCacheMax.trim()
  const sessionCacheMax = toNumber(form.sessionCacheMax)
  if (sessionCacheMaxRaw && (sessionCacheMax === undefined || sessionCacheMax <= 0)) {
    errors.sessionCacheMax = "Must be a positive integer"
  }

  const sessionCacheTtlMsRaw = form.sessionCacheTtlMs.trim()
  const sessionCacheTtlMs = toNumber(form.sessionCacheTtlMs)
  if (sessionCacheTtlMsRaw && (sessionCacheTtlMs === undefined || sessionCacheTtlMs <= 0)) {
    errors.sessionCacheTtlMs = "Must be a positive integer"
  }

  const notificationDebounceMsRaw = form.notificationDebounceMs.trim()
  const notificationDebounceMs = toNumber(form.notificationDebounceMs)
  if (notificationDebounceMsRaw && (notificationDebounceMs === undefined || notificationDebounceMs <= 0)) {
    errors.notificationDebounceMs = "Must be a positive integer"
  }

  const portRaw = form.port.trim()
  const port = toNumber(form.port)
  if (portRaw && (port === undefined || port < 1 || port > 65535)) {
    errors.port = "Must be an integer between 1 and 65535"
  }

  if (form.tokenMode === "set" && !form.token.trim()) errors.token = "Token is required when setting a new value"
  if (form.webhookSecretMode === "set" && !form.webhookSecret.trim()) {
    errors.webhookSecret = "Webhook secret is required when setting a new value"
  }

  return errors
}

export function createTelegramPatch(current: TelegramForm, initial: TelegramForm): Record<string, string | number | null> {
  const patch: Record<string, string | number | null> = {}

  if (current.mode !== initial.mode) patch.mode = current.mode

  addStringPatch(patch, "openCodeUrl", current.openCodeUrl, initial.openCodeUrl)
  addStringPatch(patch, "directory", current.directory, initial.directory)
  addNumberPatch(patch, "sessionCacheMax", current.sessionCacheMax, initial.sessionCacheMax)
  addNumberPatch(patch, "sessionCacheTtlMs", current.sessionCacheTtlMs, initial.sessionCacheTtlMs)
  addNumberPatch(patch, "notificationDebounceMs", current.notificationDebounceMs, initial.notificationDebounceMs)
  addNumberPatch(patch, "port", current.port, initial.port)
  addWebhookPathPatch(patch, current.webhookPath, initial.webhookPath)
  addStringPatch(patch, "webhookUrl", current.webhookUrl, initial.webhookUrl)
  addStringPatch(patch, "sessionStorePath", current.sessionStorePath, initial.sessionStorePath)
  addStringPatch(patch, "sessionLinkBase", current.sessionLinkBase, initial.sessionLinkBase)

  if (current.tokenMode === "clear") patch.token = null
  if (current.tokenMode === "set") patch.token = current.token.trim()
  if (current.webhookSecretMode === "clear") patch.webhookSecret = null
  if (current.webhookSecretMode === "set") patch.webhookSecret = current.webhookSecret.trim()

  return patch
}
