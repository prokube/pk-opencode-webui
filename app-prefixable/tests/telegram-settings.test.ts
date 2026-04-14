import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import * as fsp from "node:fs/promises"
import { handleExtendedEndpoint } from "../../shared/extended-api"
import { readDesiredTelegramSettingsFingerprint, writeTelegramRuntimeState } from "../../shared/telegram-settings"
import * as telegramSessionStore from "../../shared/telegram-session-store"

const envKeys = [
  "TELEGRAM_SETTINGS_PATH",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_MODE",
  "OPENCODE_API_URL",
  "API_URL",
  "OPENCODE_DIRECTORY",
  "TELEGRAM_SESSION_CACHE_MAX",
  "TELEGRAM_SESSION_CACHE_TTL_MS",
  "TELEGRAM_NOTIFY_DEBOUNCE_MS",
  "TELEGRAM_BRIDGE_PORT",
  "TELEGRAM_WEBHOOK_PATH",
  "TELEGRAM_WEBHOOK_SECRET",
  "TELEGRAM_WEBHOOK_URL",
  "TELEGRAM_SESSION_STORE_PATH",
  "TELEGRAM_SESSION_LINK_BASE",
  "TELEGRAM_RUNTIME_STATE_PATH",
  "TELEGRAM_BRIDGE_RESTART_COMMAND",
  "TELEGRAM_BRIDGE_RESTART_COMMAND_ARGV",
  "TELEGRAM_BRIDGE_S6_SERVICE_PATH",
  "TELEGRAM_BRIDGE_RESTART_TIMEOUT_MS",
  "TELEGRAM_BRIDGE_APPLY_TIMEOUT_MS",
  "TELEGRAM_BRIDGE_RESTART_TOKEN",
  "TELEGRAM_BRIDGE_ALLOW_UNAUTH_RESTART",
  "TELEGRAM_BRIDGE_RESTART_DEBUG",
] as const

const envSnapshot = new Map<string, string | undefined>()
const cleanupPaths: string[] = []

beforeEach(() => {
  for (const key of envKeys) {
    envSnapshot.set(key, process.env[key])
    delete process.env[key]
  }
})

afterEach(async () => {
  for (const key of envKeys) {
    const value = envSnapshot.get(key)
    if (value === undefined) {
      delete process.env[key]
      continue
    }
    process.env[key] = value
  }
  envSnapshot.clear()
  for (const path of cleanupPaths) {
    await rm(path, { force: true, recursive: true }).catch(() => undefined)
  }
  cleanupPaths.length = 0
})

describe("telegram settings extended API", () => {
  test("GET masks secrets and reports configured state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "telegram-settings-"))
    const path = join(dir, "telegram-settings.json")
    cleanupPaths.push(dir)

    process.env.TELEGRAM_SETTINGS_PATH = path
    process.env.TELEGRAM_BOT_TOKEN = "env-secret-token"
    process.env.TELEGRAM_WEBHOOK_SECRET = "env-webhook-secret"

    const response = await handleExtendedEndpoint(
      "/api/ext/telegram/settings",
      "GET",
      new URL("http://127.0.0.1/api/ext/telegram/settings"),
      new Request("http://127.0.0.1/api/ext/telegram/settings"),
    )

    expect(response?.status).toBe(200)
    const data = await response?.json()
    expect(data.settings.tokenConfigured).toBe(true)
    expect(data.settings.webhookSecretConfigured).toBe(true)
    expect(data.settings.token).toBeUndefined()
    expect(data.settings.webhookSecret).toBeUndefined()
    expect(data.settings.telegramAlarmChannelEnabled).toBe(true)
    expect(data.storage.path).toBeUndefined()
  })

  test("PUT validates input and returns field errors", async () => {
    const dir = await mkdtemp(join(tmpdir(), "telegram-settings-"))
    const path = join(dir, "telegram-settings.json")
    cleanupPaths.push(dir)

    process.env.TELEGRAM_SETTINGS_PATH = path
    process.env.TELEGRAM_BOT_TOKEN = "env-secret-token"

    const response = await handleExtendedEndpoint(
      "/api/ext/telegram/settings",
      "PUT",
      new URL("http://127.0.0.1/api/ext/telegram/settings"),
      new Request("http://127.0.0.1/api/ext/telegram/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: {
            mode: "invalid",
            port: 70000,
            sessionStorePath: "relative/store.json",
            telegramAlarmChannelEnabled: "yes",
          },
        }),
      }),
    )

    expect(response?.status).toBe(400)
    const data = await response?.json()
    expect(data.error).toBe("validation_failed")
    expect(data.errors).toEqual(
      expect.arrayContaining([
        { field: "mode", message: "mode must be polling or webhook" },
        { field: "port", message: "port must be an integer between 1 and 65535" },
        {
          field: "sessionStorePath",
          message:
            "sessionStorePath must be an absolute path within OPENCODE_WORKSPACE_ROOT, HOME, OPENCODE_CONFIG_DIR, or the system temp directory",
        },
        {
          field: "telegramAlarmChannelEnabled",
          message: "telegramAlarmChannelEnabled must be a boolean or null",
        },
      ]),
    )
  })

  test("session alarm endpoint persists and reads state by session id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "telegram-settings-"))
    const path = join(dir, "telegram-settings.json")
    const storePath = join(dir, "telegram-sessions.json")
    cleanupPaths.push(dir)

    process.env.TELEGRAM_SETTINGS_PATH = path
    process.env.TELEGRAM_SESSION_STORE_PATH = storePath

    const set = await handleExtendedEndpoint(
      "/api/ext/telegram/session-alarm",
      "PUT",
      new URL("http://127.0.0.1/api/ext/telegram/session-alarm"),
      new Request("http://127.0.0.1/api/ext/telegram/session-alarm", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "session-alarm-a", enabled: true }),
      }),
    )

    expect(set?.status).toBe(200)
    const setData = await set?.json()
    expect(setData).toEqual({ sessionId: "session-alarm-a", enabled: true })

    const get = await handleExtendedEndpoint(
      "/api/ext/telegram/session-alarm",
      "GET",
      new URL("http://127.0.0.1/api/ext/telegram/session-alarm?sessionId=session-alarm-a"),
      new Request("http://127.0.0.1/api/ext/telegram/session-alarm?sessionId=session-alarm-a"),
    )

    expect(get?.status).toBe(200)
    const getData = await get?.json()
    expect(getData).toEqual({ sessionId: "session-alarm-a", enabled: true })

    const stored = JSON.parse(await Bun.file(storePath).text()) as { sessionAlarms?: Record<string, boolean> }
    expect(stored.sessionAlarms?.["session-alarm-a"]).toBe(true)
  })

  test("session alarm endpoint validates session id and enabled payload", async () => {
    const dir = await mkdtemp(join(tmpdir(), "telegram-settings-"))
    cleanupPaths.push(dir)
    process.env.TELEGRAM_SETTINGS_PATH = join(dir, "telegram-settings.json")
    process.env.TELEGRAM_SESSION_STORE_PATH = join(dir, "telegram-sessions.json")

    const missing = await handleExtendedEndpoint(
      "/api/ext/telegram/session-alarm",
      "GET",
      new URL("http://127.0.0.1/api/ext/telegram/session-alarm"),
      new Request("http://127.0.0.1/api/ext/telegram/session-alarm"),
    )
    expect(missing?.status).toBe(400)

    const invalid = await handleExtendedEndpoint(
      "/api/ext/telegram/session-alarm",
      "PUT",
      new URL("http://127.0.0.1/api/ext/telegram/session-alarm"),
      new Request("http://127.0.0.1/api/ext/telegram/session-alarm", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "session-alarm-b", enabled: "yes" }),
      }),
    )
    expect(invalid?.status).toBe(400)
  })

  test("session alarm endpoint reuses cached store by session store path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "telegram-settings-"))
    const path = join(dir, "telegram-settings.json")
    const storePath = join(dir, "telegram-sessions-cache.json")
    cleanupPaths.push(dir)

    process.env.TELEGRAM_SETTINGS_PATH = path
    process.env.TELEGRAM_SESSION_STORE_PATH = storePath

    const createSpy = spyOn(telegramSessionStore, "createTelegramSessionStore")

    try {
      const set = await handleExtendedEndpoint(
        "/api/ext/telegram/session-alarm",
        "PUT",
        new URL("http://127.0.0.1/api/ext/telegram/session-alarm"),
        new Request("http://127.0.0.1/api/ext/telegram/session-alarm", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: "session-alarm-cache", enabled: true }),
        }),
      )

      const get = await handleExtendedEndpoint(
        "/api/ext/telegram/session-alarm",
        "GET",
        new URL("http://127.0.0.1/api/ext/telegram/session-alarm?sessionId=session-alarm-cache"),
        new Request("http://127.0.0.1/api/ext/telegram/session-alarm?sessionId=session-alarm-cache"),
      )

      expect(set?.status).toBe(200)
      expect(get?.status).toBe(200)
      expect(createSpy).toHaveBeenCalledTimes(1)
      expect(createSpy.mock.calls[0]?.[0]).toBe(storePath)
    } finally {
      createSpy.mockRestore()
    }
  })

  test("session alarm endpoint returns 500 when store read fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "telegram-settings-"))
    cleanupPaths.push(dir)
    process.env.TELEGRAM_SETTINGS_PATH = join(dir, "telegram-settings.json")
    process.env.TELEGRAM_SESSION_STORE_PATH = join(dir, "telegram-sessions-read-fail.json")

    const createSpy = spyOn(telegramSessionStore, "createTelegramSessionStore").mockImplementation(() => {
      return {
        get: async () => undefined,
        set: async () => undefined,
        delete: async () => undefined,
        sessionAlarmGet: async () => {
          throw new Error("mock session alarm read failure")
        },
      }
    })

    try {
      const response = await handleExtendedEndpoint(
        "/api/ext/telegram/session-alarm",
        "GET",
        new URL("http://127.0.0.1/api/ext/telegram/session-alarm?sessionId=session-alarm-read-error"),
        new Request("http://127.0.0.1/api/ext/telegram/session-alarm?sessionId=session-alarm-read-error"),
      )

      expect(response?.status).toBe(500)
      const data = await response?.json()
      expect(data).toEqual({ error: "failed to read telegram session alarm" })
    } finally {
      createSpy.mockRestore()
    }
  })

  test("session alarm endpoint returns 500 when store write fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "telegram-settings-"))
    cleanupPaths.push(dir)
    process.env.TELEGRAM_SETTINGS_PATH = join(dir, "telegram-settings.json")
    process.env.TELEGRAM_SESSION_STORE_PATH = join(dir, "telegram-sessions-write-fail.json")

    const createSpy = spyOn(telegramSessionStore, "createTelegramSessionStore").mockImplementation(() => {
      return {
        get: async () => undefined,
        set: async () => undefined,
        delete: async () => undefined,
        sessionAlarmSet: async () => {
          throw new Error("mock session alarm write failure")
        },
      }
    })

    try {
      const response = await handleExtendedEndpoint(
        "/api/ext/telegram/session-alarm",
        "PUT",
        new URL("http://127.0.0.1/api/ext/telegram/session-alarm"),
        new Request("http://127.0.0.1/api/ext/telegram/session-alarm", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: "session-alarm-write-error", enabled: true }),
        }),
      )

      expect(response?.status).toBe(500)
      const data = await response?.json()
      expect(data).toEqual({ error: "failed to update telegram session alarm" })
    } finally {
      createSpy.mockRestore()
    }
  })

  test("PUT persists settings and marks restart-required fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "telegram-settings-"))
    const path = join(dir, "telegram-settings.json")
    cleanupPaths.push(dir)

    process.env.TELEGRAM_SETTINGS_PATH = path
    process.env.TELEGRAM_BOT_TOKEN = "env-secret-token"

    const update = await handleExtendedEndpoint(
      "/api/ext/telegram/settings",
      "PUT",
      new URL("http://127.0.0.1/api/ext/telegram/settings"),
      new Request("http://127.0.0.1/api/ext/telegram/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: {
            token: "persisted-secret-token",
            openCodeUrl: "http://127.0.0.1:4199",
            notificationDebounceMs: 30000,
            telegramAlarmChannelEnabled: false,
          },
        }),
      }),
    )

    expect(update?.status).toBe(200)
    const updateData = await update?.json()
    expect(updateData.changedFields).toEqual(
      expect.arrayContaining(["token", "openCodeUrl", "notificationDebounceMs", "telegramAlarmChannelEnabled"]),
    )
    expect(updateData.restartRequired).toBe(true)
    expect(updateData.restartRequiredFields).toEqual(
      expect.arrayContaining(["token", "openCodeUrl", "notificationDebounceMs", "telegramAlarmChannelEnabled"]),
    )
    expect(updateData.storage.path).toBeUndefined()

    const read = await handleExtendedEndpoint(
      "/api/ext/telegram/settings",
      "GET",
      new URL("http://127.0.0.1/api/ext/telegram/settings"),
      new Request("http://127.0.0.1/api/ext/telegram/settings"),
    )
    const readData = await read?.json()
    expect(readData.settings.tokenConfigured).toBe(true)
    expect(readData.settings.tokenSource).toBe("persisted")
    expect(readData.settings.openCodeUrl).toBe("http://127.0.0.1:4199/")
    expect(readData.settings.telegramAlarmChannelEnabled).toBe(false)
    expect(readData.settings.token).toBeUndefined()
    expect(readData.metadata.runtimeReloadableFields).toEqual([])
    expect(readData.metadata.restartRequiredFields).toContain("token")

    const stored = JSON.parse(await Bun.file(path).text()) as {
      settings?: Record<string, string | number | boolean>
    }
    expect(stored.settings?.token).toBe("persisted-secret-token")
    expect(stored.settings?.telegramAlarmChannelEnabled).toBe(false)
  })

  test("PUT allows null to clear persisted required and numeric fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "telegram-settings-"))
    const path = join(dir, "telegram-settings.json")
    cleanupPaths.push(dir)

    process.env.TELEGRAM_SETTINGS_PATH = path
    process.env.TELEGRAM_BOT_TOKEN = "env-token"
    process.env.OPENCODE_API_URL = "http://127.0.0.1:4299"
    process.env.TELEGRAM_SESSION_CACHE_MAX = "777"
    process.env.TELEGRAM_BRIDGE_PORT = "4197"

    const seed = await handleExtendedEndpoint(
      "/api/ext/telegram/settings",
      "PUT",
      new URL("http://127.0.0.1/api/ext/telegram/settings"),
      new Request("http://127.0.0.1/api/ext/telegram/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: {
            token: "persisted-token",
            openCodeUrl: "http://127.0.0.1:4499",
            sessionCacheMax: 99,
            port: 5001,
          },
        }),
      }),
    )
    expect(seed?.status).toBe(200)

    const clear = await handleExtendedEndpoint(
      "/api/ext/telegram/settings",
      "PUT",
      new URL("http://127.0.0.1/api/ext/telegram/settings"),
      new Request("http://127.0.0.1/api/ext/telegram/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: {
            token: null,
            openCodeUrl: null,
            sessionCacheMax: null,
            port: null,
          },
        }),
      }),
    )

    expect(clear?.status).toBe(200)
    const clearData = await clear?.json()
    expect(clearData.changedFields).toEqual(expect.arrayContaining(["token", "openCodeUrl", "sessionCacheMax", "port"]))

    const read = await handleExtendedEndpoint(
      "/api/ext/telegram/settings",
      "GET",
      new URL("http://127.0.0.1/api/ext/telegram/settings"),
      new Request("http://127.0.0.1/api/ext/telegram/settings"),
    )
    expect(read?.status).toBe(200)
    const data = await read?.json()
    expect(data.settings.tokenSource).toBe("env")
    expect(data.settings.openCodeUrl).toBe("http://127.0.0.1:4299/")
    expect(data.settings.sessionCacheMax).toBe(777)
    expect(data.settings.port).toBe(4197)

    const stored = JSON.parse(await Bun.file(path).text()) as {
      settings?: Record<string, string | number | boolean>
    }
    expect(stored.settings?.token).toBeUndefined()
    expect(stored.settings?.openCodeUrl).toBeUndefined()
    expect(stored.settings?.sessionCacheMax).toBeUndefined()
    expect(stored.settings?.port).toBeUndefined()
  })

  test("PUT allows empty string to clear persisted openCodeUrl", async () => {
    const dir = await mkdtemp(join(tmpdir(), "telegram-settings-"))
    const path = join(dir, "telegram-settings.json")
    cleanupPaths.push(dir)

    process.env.TELEGRAM_SETTINGS_PATH = path
    process.env.OPENCODE_API_URL = "http://127.0.0.1:4299"

    const seed = await handleExtendedEndpoint(
      "/api/ext/telegram/settings",
      "PUT",
      new URL("http://127.0.0.1/api/ext/telegram/settings"),
      new Request("http://127.0.0.1/api/ext/telegram/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: {
            openCodeUrl: "http://127.0.0.1:4499",
          },
        }),
      }),
    )
    expect(seed?.status).toBe(200)

    const clear = await handleExtendedEndpoint(
      "/api/ext/telegram/settings",
      "PUT",
      new URL("http://127.0.0.1/api/ext/telegram/settings"),
      new Request("http://127.0.0.1/api/ext/telegram/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: {
            openCodeUrl: "",
          },
        }),
      }),
    )
    expect(clear?.status).toBe(200)
    const clearData = await clear?.json()
    expect(clearData.changedFields).toEqual(expect.arrayContaining(["openCodeUrl"]))

    const read = await handleExtendedEndpoint(
      "/api/ext/telegram/settings",
      "GET",
      new URL("http://127.0.0.1/api/ext/telegram/settings"),
      new Request("http://127.0.0.1/api/ext/telegram/settings"),
    )
    expect(read?.status).toBe(200)
    const data = await read?.json()
    expect(data.settings.openCodeUrl).toBe("http://127.0.0.1:4299/")

    const stored = JSON.parse(await Bun.file(path).text()) as {
      settings?: Record<string, string | number | boolean>
    }
    expect(stored.settings?.openCodeUrl).toBeUndefined()
  })

  test("PUT allows empty string to clear persisted sessionStorePath", async () => {
    const dir = await mkdtemp(join(tmpdir(), "telegram-settings-"))
    const path = join(dir, "telegram-settings.json")
    cleanupPaths.push(dir)

    const envStore = join(dir, "env-sessions.json")
    const persistedStore = join(dir, "persisted-sessions.json")
    process.env.TELEGRAM_SETTINGS_PATH = path
    process.env.TELEGRAM_SESSION_STORE_PATH = envStore

    const seed = await handleExtendedEndpoint(
      "/api/ext/telegram/settings",
      "PUT",
      new URL("http://127.0.0.1/api/ext/telegram/settings"),
      new Request("http://127.0.0.1/api/ext/telegram/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: {
            sessionStorePath: persistedStore,
          },
        }),
      }),
    )
    expect(seed?.status).toBe(200)

    const clear = await handleExtendedEndpoint(
      "/api/ext/telegram/settings",
      "PUT",
      new URL("http://127.0.0.1/api/ext/telegram/settings"),
      new Request("http://127.0.0.1/api/ext/telegram/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: {
            sessionStorePath: "",
          },
        }),
      }),
    )
    expect(clear?.status).toBe(200)
    const clearData = await clear?.json()
    expect(clearData.changedFields).toEqual(expect.arrayContaining(["sessionStorePath"]))

    const read = await handleExtendedEndpoint(
      "/api/ext/telegram/settings",
      "GET",
      new URL("http://127.0.0.1/api/ext/telegram/settings"),
      new Request("http://127.0.0.1/api/ext/telegram/settings"),
    )
    expect(read?.status).toBe(200)
    const data = await read?.json()
    expect(data.settings.sessionStorePath).toBe(envStore)

    const stored = JSON.parse(await Bun.file(path).text()) as {
      settings?: Record<string, string | number | boolean>
    }
    expect(stored.settings?.sessionStorePath).toBeUndefined()
  })

  test("PUT returns 500 when persistence fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "telegram-settings-"))
    cleanupPaths.push(dir)
    const blocker = join(dir, "blocked")
    await writeFile(blocker, "file", "utf-8")

    process.env.TELEGRAM_SETTINGS_PATH = join(blocker, "telegram-settings.json")

    const response = await handleExtendedEndpoint(
      "/api/ext/telegram/settings",
      "PUT",
      new URL("http://127.0.0.1/api/ext/telegram/settings"),
      new Request("http://127.0.0.1/api/ext/telegram/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: { token: "persisted-token" } }),
      }),
    )

    expect(response?.status).toBe(500)
    const data = await response?.json()
    expect(data).toEqual({ error: "failed to update telegram settings" })
  })

  test("PUT no-op does not rewrite file or bump updatedAt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "telegram-settings-"))
    const path = join(dir, "telegram-settings.json")
    cleanupPaths.push(dir)

    process.env.TELEGRAM_SETTINGS_PATH = path

    const seed = await handleExtendedEndpoint(
      "/api/ext/telegram/settings",
      "PUT",
      new URL("http://127.0.0.1/api/ext/telegram/settings"),
      new Request("http://127.0.0.1/api/ext/telegram/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: {
            openCodeUrl: "http://127.0.0.1:4100",
          },
        }),
      }),
    )
    expect(seed?.status).toBe(200)
    const seedData = await seed?.json()
    const before = await Bun.file(path).text()

    const noop = await handleExtendedEndpoint(
      "/api/ext/telegram/settings",
      "PUT",
      new URL("http://127.0.0.1/api/ext/telegram/settings"),
      new Request("http://127.0.0.1/api/ext/telegram/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: {
            openCodeUrl: "http://127.0.0.1:4100/",
          },
        }),
      }),
    )

    expect(noop?.status).toBe(200)
    const noopData = await noop?.json()
    expect(noopData.changedFields).toEqual([])
    expect(noopData.restartRequired).toBe(false)
    expect(noopData.restartRequiredFields).toEqual([])
    expect(noopData.storage.updatedAt).toBe(seedData.storage.updatedAt)
    expect(noopData.storage.path).toBeUndefined()

    const after = await Bun.file(path).text()
    expect(after).toBe(before)
  })

  test("GET keeps valid persisted fields when persisted URL fields are malformed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "telegram-settings-"))
    const path = join(dir, "telegram-settings.json")
    cleanupPaths.push(dir)

    process.env.TELEGRAM_SETTINGS_PATH = path
    process.env.OPENCODE_API_URL = "http://127.0.0.1:4299"
    process.env.TELEGRAM_WEBHOOK_URL = "https://hooks.example.com/telegram"
    process.env.TELEGRAM_SESSION_LINK_BASE = "https://opencode.example.com/notebook"

    await writeFile(
      path,
      JSON.stringify(
        {
          version: 1,
          updatedAt: new Date().toISOString(),
          settings: {
            token: "persisted-token",
            openCodeUrl: "not-a-url",
            webhookUrl: "also-not-a-url",
            sessionLinkBase: "bad-link-base",
          },
        },
        null,
        2,
      ),
      "utf-8",
    )

    const read = await handleExtendedEndpoint(
      "/api/ext/telegram/settings",
      "GET",
      new URL("http://127.0.0.1/api/ext/telegram/settings"),
      new Request("http://127.0.0.1/api/ext/telegram/settings"),
    )

    expect(read?.status).toBe(200)
    const data = await read?.json()
    expect(data.settings.tokenConfigured).toBe(true)
    expect(data.settings.tokenSource).toBe("persisted")
    expect(data.settings.openCodeUrl).toBe("http://127.0.0.1:4299/")
    expect(data.settings.webhookUrl).toBe("https://hooks.example.com/telegram")
    expect(data.settings.sessionLinkBase).toBe("https://opencode.example.com/notebook")
  })

  test("GET accepts persisted URL fields surrounded by whitespace", async () => {
    const dir = await mkdtemp(join(tmpdir(), "telegram-settings-"))
    const path = join(dir, "telegram-settings.json")
    cleanupPaths.push(dir)

    process.env.TELEGRAM_SETTINGS_PATH = path
    process.env.OPENCODE_API_URL = "http://127.0.0.1:4299"
    process.env.TELEGRAM_WEBHOOK_URL = "https://hooks.example.com/env"

    await writeFile(
      path,
      JSON.stringify(
        {
          version: 1,
          updatedAt: new Date().toISOString(),
            settings: {
              openCodeUrl: "  https://persisted.example.com/base  ",
              webhookUrl: "  https://hooks.example.com/persisted  ",
              sessionLinkBase: "  https://persisted.example.com/notebook/  ",
            },
          },
        null,
        2,
      ),
      "utf-8",
    )

    const read = await handleExtendedEndpoint(
      "/api/ext/telegram/settings",
      "GET",
      new URL("http://127.0.0.1/api/ext/telegram/settings"),
      new Request("http://127.0.0.1/api/ext/telegram/settings"),
    )

    expect(read?.status).toBe(200)
    const data = await read?.json()
    expect(data.settings.openCodeUrl).toBe("https://persisted.example.com/base")
    expect(data.settings.webhookUrl).toBe("https://hooks.example.com/persisted")
    expect(data.settings.sessionLinkBase).toBe("https://persisted.example.com/notebook")
  })

  test("PUT cleans temporary file when backup rename fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "telegram-settings-"))
    const path = join(dir, "telegram-settings.json")
    cleanupPaths.push(dir)

    process.env.TELEGRAM_SETTINGS_PATH = path

    await writeFile(
      path,
      JSON.stringify(
        {
          version: 1,
          updatedAt: new Date().toISOString(),
          settings: {
            token: "seed",
          },
        },
        null,
        2,
      ),
      "utf-8",
    )

    const realRename = fsp.rename
    const renameSpy = spyOn(fsp, "rename").mockImplementation(async (from, to) => {
      const src = String(from)
      const dest = String(to)
      if (src.endsWith(".tmp") && dest === path) {
        const err = new Error("mock replace conflict") as Error & { code?: string }
        err.code = "EPERM"
        throw err
      }
      if (src === path && dest.includes(`${path}.bak.`)) {
        const err = new Error("mock backup failure") as Error & { code?: string }
        err.code = "EPERM"
        throw err
      }
      return realRename(from, to)
    })

    try {
      const response = await handleExtendedEndpoint(
        "/api/ext/telegram/settings",
        "PUT",
        new URL("http://127.0.0.1/api/ext/telegram/settings"),
        new Request("http://127.0.0.1/api/ext/telegram/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ settings: { token: "changed" } }),
        }),
      )

      expect(response?.status).toBe(500)
      const files = await readdir(dir)
      const leftovers = files.filter((entry) => entry.startsWith(".telegram-settings.json.") && entry.endsWith(".tmp"))
      expect(leftovers).toEqual([])
    } finally {
      renameSpy.mockRestore()
    }
  })

  test("runtime state write replaces existing file when rename reports conflict", async () => {
    const dir = await mkdtemp(join(tmpdir(), "telegram-settings-"))
    const path = join(dir, "telegram-runtime-state.json")
    cleanupPaths.push(dir)

    process.env.TELEGRAM_RUNTIME_STATE_PATH = path

    await writeTelegramRuntimeState({ mode: "polling", port: 4097 })

    const realRename = fsp.rename
    let injected = false
    const renameSpy = spyOn(fsp, "rename").mockImplementation(async (from, to) => {
      const src = String(from)
      const dest = String(to)
      if (!injected && src.endsWith(".tmp") && dest === path) {
        injected = true
        const err = new Error("mock replace conflict") as Error & { code?: string }
        err.code = "EPERM"
        throw err
      }
      return realRename(from, to)
    })

    try {
      await writeTelegramRuntimeState({ mode: "webhook", port: 4188 })

      const text = await readFile(path, "utf-8")
      const data = JSON.parse(text) as { mode: string; port: number }
      expect(data.mode).toBe("webhook")
      expect(data.port).toBe(4188)

      const files = await readdir(dir)
      const leftovers = files.filter((entry) => entry.startsWith(".telegram-runtime-state.json.") && entry.endsWith(".tmp"))
      expect(leftovers).toEqual([])
    } finally {
      renameSpy.mockRestore()
    }
  })

  test("GET falls back to env when persisted token and webhookSecret are whitespace", async () => {
    const dir = await mkdtemp(join(tmpdir(), "telegram-settings-"))
    const path = join(dir, "telegram-settings.json")
    cleanupPaths.push(dir)

    process.env.TELEGRAM_SETTINGS_PATH = path
    process.env.TELEGRAM_BOT_TOKEN = "env-token"
    process.env.TELEGRAM_WEBHOOK_SECRET = "env-secret"

    await writeFile(
      path,
      JSON.stringify(
        {
          version: 1,
          updatedAt: new Date().toISOString(),
          settings: {
            token: "   ",
            webhookSecret: "\n\t ",
          },
        },
        null,
        2,
      ),
      "utf-8",
    )

    const read = await handleExtendedEndpoint(
      "/api/ext/telegram/settings",
      "GET",
      new URL("http://127.0.0.1/api/ext/telegram/settings"),
      new Request("http://127.0.0.1/api/ext/telegram/settings"),
    )

    expect(read?.status).toBe(200)
    const data = await read?.json()
    expect(data.settings.tokenConfigured).toBe(true)
    expect(data.settings.tokenSource).toBe("env")
    expect(data.settings.webhookSecretConfigured).toBe(true)
    expect(data.settings.webhookSecretSource).toBe("env")
  })

  test("GET recovers persisted settings from backup when primary is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "telegram-settings-"))
    const path = join(dir, "telegram-settings.json")
    const backup = `${path}.bak.${Date.now()}.recover`
    cleanupPaths.push(dir)

    process.env.TELEGRAM_SETTINGS_PATH = path

    await writeFile(
      backup,
      JSON.stringify(
        {
          version: 1,
          updatedAt: new Date().toISOString(),
          settings: {
            token: "persisted-token",
            webhookSecret: "persisted-secret",
          },
        },
        null,
        2,
      ),
      "utf-8",
    )

    const read = await handleExtendedEndpoint(
      "/api/ext/telegram/settings",
      "GET",
      new URL("http://127.0.0.1/api/ext/telegram/settings"),
      new Request("http://127.0.0.1/api/ext/telegram/settings"),
    )

    expect(read?.status).toBe(200)
    const data = await read?.json()
    expect(data.settings.tokenConfigured).toBe(true)
    expect(data.settings.tokenSource).toBe("persisted")
    expect(data.settings.webhookSecretConfigured).toBe(true)
    expect(data.settings.webhookSecretSource).toBe("persisted")
    expect(await Bun.file(path).exists()).toBe(true)
    expect(await Bun.file(backup).exists()).toBe(false)
  })

  test("GET telegram health returns bridge checks and no secrets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "telegram-settings-"))
    cleanupPaths.push(dir)
    process.env.TELEGRAM_SETTINGS_PATH = join(dir, "telegram-settings.json")
    process.env.TELEGRAM_BOT_TOKEN = "test-secret-token"

    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          status: "healthy",
          checkedAt: new Date().toISOString(),
          process: { status: "up", pid: 123, uptimeSec: 10, mode: "polling" },
          config: {
            status: "ok",
            tokenConfigured: true,
            webhookSecretConfigured: false,
            openCodeUrlConfigured: true,
            sessionStorePathConfigured: true,
            directoryConfigured: false,
            mode: "polling",
          },
          dependencies: {
            telegramApi: { status: "ok", message: "Telegram API is reachable" },
            openCodeApi: { status: "ok", message: "OpenCode API is reachable" },
          },
        }),
        { status: 200 },
      )
    })

    try {
      const response = await handleExtendedEndpoint(
        "/api/ext/telegram/health",
        "GET",
        new URL("http://127.0.0.1/api/ext/telegram/health"),
        new Request("http://127.0.0.1/api/ext/telegram/health"),
      )

      expect(response?.status).toBe(200)
      const data = await response?.json()
      expect(data.status).toBe("healthy")
      expect(data.bridgeReachable).toBe(true)
      expect(data.dependencies.telegramApi.status).toBe("ok")
      expect(data.config.openCodeUrlConfigured).toBe(true)
      expect(data.config.sessionStorePathConfigured).toBe(true)
      expect(JSON.stringify(data)).not.toContain("test-secret-token")
    } finally {
      fetchSpy.mockRestore()
    }
  })

  test("GET telegram health waits for bridge dependency budget before timing out", async () => {
    const dir = await mkdtemp(join(tmpdir(), "telegram-settings-"))
    cleanupPaths.push(dir)
    process.env.TELEGRAM_SETTINGS_PATH = join(dir, "telegram-settings.json")

    const timeoutSpy = spyOn(AbortSignal, "timeout")
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          status: "healthy",
          checkedAt: new Date().toISOString(),
          process: { status: "up", pid: 123, uptimeSec: 10, mode: "polling" },
          config: {
            status: "ok",
            tokenConfigured: true,
            webhookSecretConfigured: false,
            openCodeUrlConfigured: true,
            sessionStorePathConfigured: true,
            directoryConfigured: false,
            mode: "polling",
          },
          dependencies: {
            telegramApi: { status: "ok", message: "Telegram API is reachable" },
            openCodeApi: { status: "ok", message: "OpenCode API is reachable" },
          },
        }),
        { status: 200 },
      )
    })

    try {
      await handleExtendedEndpoint(
        "/api/ext/telegram/health",
        "GET",
        new URL("http://127.0.0.1/api/ext/telegram/health"),
        new Request("http://127.0.0.1/api/ext/telegram/health"),
      )

      expect(timeoutSpy).toHaveBeenCalledWith(7_000)
    } finally {
      fetchSpy.mockRestore()
      timeoutSpy.mockRestore()
    }
  })

  test("GET telegram health strips unexpected bridge secret fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "telegram-settings-"))
    cleanupPaths.push(dir)
    process.env.TELEGRAM_SETTINGS_PATH = join(dir, "telegram-settings.json")

    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          status: "healthy",
          checkedAt: new Date().toISOString(),
          process: { status: "up", pid: 123, uptimeSec: 10, mode: "polling", token: "secret" },
          config: {
            status: "ok",
            tokenConfigured: true,
            webhookSecretConfigured: true,
            openCodeUrlConfigured: true,
            sessionStorePathConfigured: true,
            directoryConfigured: false,
            mode: "polling",
            token: "super-secret",
            webhookSecret: "also-secret",
          },
          dependencies: {
            telegramApi: { status: "ok", message: "Telegram API is reachable", detail: "sensitive" },
            openCodeApi: { status: "ok", message: "OpenCode API is reachable" },
          },
          debugToken: "do-not-leak",
        }),
        { status: 200 },
      )
    })

    try {
      const response = await handleExtendedEndpoint(
        "/api/ext/telegram/health",
        "GET",
        new URL("http://127.0.0.1/api/ext/telegram/health"),
        new Request("http://127.0.0.1/api/ext/telegram/health"),
      )

      expect(response?.status).toBe(200)
      const data = await response?.json()
      expect(data.status).toBe("healthy")
      expect(data.config.token).toBeUndefined()
      expect(data.config.webhookSecret).toBeUndefined()
      expect(data.config.openCodeUrl).toBeUndefined()
      expect(data.config.sessionStorePath).toBeUndefined()
      expect(data.debugToken).toBeUndefined()
      expect(data.process.token).toBeUndefined()
      expect(data.dependencies.telegramApi.detail).toBeUndefined()
    } finally {
      fetchSpy.mockRestore()
    }
  })

  test("GET telegram health reports config error when bridge is down", async () => {
    const dir = await mkdtemp(join(tmpdir(), "telegram-settings-"))
    cleanupPaths.push(dir)
    process.env.TELEGRAM_SETTINGS_PATH = join(dir, "telegram-settings.json")

    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("bridge unreachable")
    })

    try {
      const response = await handleExtendedEndpoint(
        "/api/ext/telegram/health",
        "GET",
        new URL("http://127.0.0.1/api/ext/telegram/health"),
        new Request("http://127.0.0.1/api/ext/telegram/health"),
      )

      expect(response?.status).toBe(200)
      const data = await response?.json()
      expect(data.status).toBe("down")
      expect(data.bridgeReachable).toBe(false)
      expect(data.config.openCodeUrl).toBeUndefined()
      expect(data.config.sessionStorePath).toBeUndefined()
      expect(data.config.openCodeUrlConfigured).toBe(true)
      expect(data.config.sessionStorePathConfigured).toBe(true)
      expect(data.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "config" }),
        ]),
      )
    } finally {
      fetchSpy.mockRestore()
    }
  })

  test("GET telegram restart status reports pending when runtime state differs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "telegram-settings-"))
    cleanupPaths.push(dir)
    const settingsPath = join(dir, "telegram-settings.json")
    const runtimeStatePath = join(dir, "telegram-runtime-state.json")

    process.env.TELEGRAM_SETTINGS_PATH = settingsPath
    process.env.TELEGRAM_RUNTIME_STATE_PATH = runtimeStatePath

    const desired = readDesiredTelegramSettingsFingerprint()
    await writeFile(
      runtimeStatePath,
      JSON.stringify(
        {
          version: 1,
          appliedAt: new Date().toISOString(),
          pid: 123,
          mode: "polling",
          port: 4097,
          settingsFingerprint: `${desired}-stale`,
        },
        null,
        2,
      ),
      "utf-8",
    )

    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("bridge unavailable")
    })

    try {
      const response = await handleExtendedEndpoint(
        "/api/ext/telegram/restart",
        "GET",
        new URL("http://127.0.0.1/api/ext/telegram/restart"),
        new Request("http://127.0.0.1/api/ext/telegram/restart"),
      )

      expect(response?.status).toBe(200)
      const data = await response?.json()
      expect(data.status).toBe("pending_restart")
      expect(data.pendingRestart).toBe(true)
      expect(data.bridgeReachable).toBe(false)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  test("GET telegram restart status probes applied runtime port first", async () => {
    const dir = await mkdtemp(join(tmpdir(), "telegram-settings-"))
    cleanupPaths.push(dir)
    const settingsPath = join(dir, "telegram-settings.json")
    const runtimeStatePath = join(dir, "telegram-runtime-state.json")

    process.env.TELEGRAM_SETTINGS_PATH = settingsPath
    process.env.TELEGRAM_RUNTIME_STATE_PATH = runtimeStatePath

    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          version: 1,
          updatedAt: new Date().toISOString(),
          settings: { port: 4999 },
        },
        null,
        2,
      ),
      "utf-8",
    )

    const desired = readDesiredTelegramSettingsFingerprint()
    await writeFile(
      runtimeStatePath,
      JSON.stringify(
        {
          version: 1,
          appliedAt: new Date().toISOString(),
          pid: 123,
          mode: "polling",
          port: 4097,
          settingsFingerprint: `${desired}-stale`,
        },
        null,
        2,
      ),
      "utf-8",
    )

    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes(":4097/health")) {
        return new Response(JSON.stringify({ status: "healthy", process: { status: "up" } }), { status: 200 })
      }
      throw new Error("bridge unavailable")
    })

    try {
      const response = await handleExtendedEndpoint(
        "/api/ext/telegram/restart",
        "GET",
        new URL("http://127.0.0.1/api/ext/telegram/restart"),
        new Request("http://127.0.0.1/api/ext/telegram/restart"),
      )

      expect(response?.status).toBe(200)
      const data = await response?.json()
      expect(data.bridgeReachable).toBe(true)
      expect(data.bridgeHealthy).toBe(true)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  test("POST telegram restart requires explicit authorization", async () => {
    const dir = await mkdtemp(join(tmpdir(), "telegram-settings-"))
    cleanupPaths.push(dir)
    const settingsPath = join(dir, "telegram-settings.json")
    const runtimeStatePath = join(dir, "telegram-runtime-state.json")

    process.env.TELEGRAM_SETTINGS_PATH = settingsPath
    process.env.TELEGRAM_RUNTIME_STATE_PATH = runtimeStatePath

    const desired = readDesiredTelegramSettingsFingerprint()
    await writeFile(
      runtimeStatePath,
      JSON.stringify(
        {
          version: 1,
          appliedAt: new Date().toISOString(),
          pid: 222,
          mode: "polling",
          port: 4097,
          settingsFingerprint: `${desired}-old`,
        },
        null,
        2,
      ),
      "utf-8",
    )

    const response = await handleExtendedEndpoint(
      "/api/ext/telegram/restart",
      "POST",
      new URL("http://127.0.0.1/api/ext/telegram/restart"),
      new Request("http://127.0.0.1/api/ext/telegram/restart", { method: "POST" }),
    )

    expect(response?.status).toBe(403)
    const data = await response?.json()
    expect(data.error).toBe("forbidden")
    expect(data.message).toContain("not authorized")
  })

  test("POST telegram restart returns actionable command failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "telegram-settings-"))
    cleanupPaths.push(dir)
    const settingsPath = join(dir, "telegram-settings.json")
    const runtimeStatePath = join(dir, "telegram-runtime-state.json")

    process.env.TELEGRAM_SETTINGS_PATH = settingsPath
    process.env.TELEGRAM_RUNTIME_STATE_PATH = runtimeStatePath
    process.env.TELEGRAM_BRIDGE_RESTART_COMMAND = "exit 37"
    process.env.TELEGRAM_BRIDGE_ALLOW_UNAUTH_RESTART = "true"

    const desired = readDesiredTelegramSettingsFingerprint()
    await writeFile(
      runtimeStatePath,
      JSON.stringify(
        {
          version: 1,
          appliedAt: new Date().toISOString(),
          pid: 222,
          mode: "polling",
          port: 4097,
          settingsFingerprint: `${desired}-old`,
        },
        null,
        2,
      ),
      "utf-8",
    )

    const response = await handleExtendedEndpoint(
      "/api/ext/telegram/restart",
      "POST",
      new URL("http://127.0.0.1/api/ext/telegram/restart"),
      new Request("http://127.0.0.1/api/ext/telegram/restart", { method: "POST" }),
    )

    expect(response?.status).toBe(500)
    const data = await response?.json()
    expect(data.error).toBe("restart_failed")
    expect(data.message).toContain("exit code 37")
    expect(data.command).toBeUndefined()
    expect(data.stdout).toBeUndefined()
    expect(data.stderr).toBeUndefined()
    expect(data.hint).toContain("service supervision")
  })

  test("POST telegram restart returns actionable spawn failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "telegram-settings-"))
    cleanupPaths.push(dir)
    const settingsPath = join(dir, "telegram-settings.json")
    const runtimeStatePath = join(dir, "telegram-runtime-state.json")

    process.env.TELEGRAM_SETTINGS_PATH = settingsPath
    process.env.TELEGRAM_RUNTIME_STATE_PATH = runtimeStatePath
    process.env.TELEGRAM_BRIDGE_ALLOW_UNAUTH_RESTART = "true"

    const desired = readDesiredTelegramSettingsFingerprint()
    await writeFile(
      runtimeStatePath,
      JSON.stringify(
        {
          version: 1,
          appliedAt: new Date().toISOString(),
          pid: 222,
          mode: "polling",
          port: 4097,
          settingsFingerprint: `${desired}-old`,
        },
        null,
        2,
      ),
      "utf-8",
    )

    const spawnSpy = spyOn(Bun, "spawn").mockImplementation(() => {
      throw new Error("spawn ENOENT")
    })

    try {
      const response = await handleExtendedEndpoint(
        "/api/ext/telegram/restart",
        "POST",
        new URL("http://127.0.0.1/api/ext/telegram/restart"),
        new Request("http://127.0.0.1/api/ext/telegram/restart", { method: "POST" }),
      )

      expect(response?.status).toBe(500)
      const data = await response?.json()
      expect(data.error).toBe("restart_failed")
      expect(data.message).toContain("failed to start")
      expect(data.stderr).toBeUndefined()
      expect(data.hint).toContain("service supervision")
    } finally {
      spawnSpy.mockRestore()
    }
  })

  test("POST telegram restart waits for applied runtime state and healthy bridge", async () => {
    const dir = await mkdtemp(join(tmpdir(), "telegram-settings-"))
    cleanupPaths.push(dir)
    const settingsPath = join(dir, "telegram-settings.json")
    const runtimeStatePath = join(dir, "telegram-runtime-state.json")
    const appliedRuntimeStatePath = join(dir, "telegram-runtime-state-applied.json")

    process.env.TELEGRAM_SETTINGS_PATH = settingsPath
    process.env.TELEGRAM_RUNTIME_STATE_PATH = runtimeStatePath
    process.env.TELEGRAM_BRIDGE_RESTART_COMMAND_ARGV = JSON.stringify([
      process.execPath,
      "-e",
      `require(\"node:fs\").copyFileSync(${JSON.stringify(appliedRuntimeStatePath)}, ${JSON.stringify(runtimeStatePath)})`,
    ])
    process.env.TELEGRAM_BRIDGE_APPLY_TIMEOUT_MS = "6000"
    process.env.TELEGRAM_BRIDGE_ALLOW_UNAUTH_RESTART = "true"

    const desired = readDesiredTelegramSettingsFingerprint()
    await writeFile(
      runtimeStatePath,
      JSON.stringify(
        {
          version: 1,
          appliedAt: new Date().toISOString(),
          pid: 321,
          mode: "polling",
          port: 4097,
          settingsFingerprint: `${desired}-old`,
        },
        null,
        2,
      ),
      "utf-8",
    )
    await writeFile(
      appliedRuntimeStatePath,
      JSON.stringify(
        {
          version: 1,
          appliedAt: new Date().toISOString(),
          pid: 999,
          mode: "polling",
          port: 4097,
          settingsFingerprint: desired,
        },
        null,
        2,
      ),
      "utf-8",
    )

    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          status: "healthy",
          checkedAt: new Date().toISOString(),
          process: { status: "up", pid: 999, uptimeSec: 4, mode: "polling" },
          config: {
            status: "ok",
            tokenConfigured: true,
            webhookSecretConfigured: false,
            openCodeUrlConfigured: true,
            sessionStorePathConfigured: true,
            directoryConfigured: false,
            mode: "polling",
          },
          dependencies: {
            telegramApi: { status: "ok", message: "Telegram API is reachable" },
            openCodeApi: { status: "ok", message: "OpenCode API is reachable" },
          },
        }),
        { status: 200 },
      )
    })

    try {
      const response = await handleExtendedEndpoint(
        "/api/ext/telegram/restart",
        "POST",
        new URL("http://127.0.0.1/api/ext/telegram/restart"),
        new Request("http://127.0.0.1/api/ext/telegram/restart", { method: "POST" }),
      )

      expect(response?.status).toBe(200)
      const data = await response?.json()
      expect(data.ok).toBe(true)
      expect(data.restarted).toBe(true)
      expect(data.status.pendingRestart).toBe(false)
      expect(data.health.process.status).toBe("up")
    } finally {
      fetchSpy.mockRestore()
    }
  })

  test("POST telegram restart captures output only when debug is enabled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "telegram-settings-"))
    cleanupPaths.push(dir)
    const settingsPath = join(dir, "telegram-settings.json")
    const runtimeStatePath = join(dir, "telegram-runtime-state.json")

    process.env.TELEGRAM_SETTINGS_PATH = settingsPath
    process.env.TELEGRAM_RUNTIME_STATE_PATH = runtimeStatePath
    process.env.TELEGRAM_BRIDGE_RESTART_COMMAND_ARGV = JSON.stringify(["test-restart"])
    process.env.TELEGRAM_BRIDGE_ALLOW_UNAUTH_RESTART = "true"

    const desired = readDesiredTelegramSettingsFingerprint()
    await writeFile(
      runtimeStatePath,
      JSON.stringify(
        {
          version: 1,
          appliedAt: new Date().toISOString(),
          pid: 333,
          mode: "polling",
          port: 4097,
          settingsFingerprint: `${desired}-old`,
        },
        null,
        2,
      ),
      "utf-8",
    )

    const spawnSpy = spyOn(Bun, "spawn").mockImplementation(() => {
      return {
        exited: Promise.resolve(1),
        stdout: undefined,
        stderr: undefined,
        kill: () => undefined,
      } as unknown as ReturnType<typeof Bun.spawn>
    })

    try {
      const first = await handleExtendedEndpoint(
        "/api/ext/telegram/restart",
        "POST",
        new URL("http://127.0.0.1/api/ext/telegram/restart"),
        new Request("http://127.0.0.1/api/ext/telegram/restart", { method: "POST" }),
      )
      expect(first?.status).toBe(500)

      process.env.TELEGRAM_BRIDGE_RESTART_DEBUG = "true"

      const second = await handleExtendedEndpoint(
        "/api/ext/telegram/restart",
        "POST",
        new URL("http://127.0.0.1/api/ext/telegram/restart"),
        new Request("http://127.0.0.1/api/ext/telegram/restart", { method: "POST" }),
      )
      expect(second?.status).toBe(500)

      const firstCall = spawnSpy.mock.calls.at(0)?.[0] as Parameters<typeof Bun.spawn>[0] | undefined
      const secondCall = spawnSpy.mock.calls.at(1)?.[0] as Parameters<typeof Bun.spawn>[0] | undefined
      expect(firstCall?.stdout).toBe("inherit")
      expect(firstCall?.stderr).toBe("inherit")
      expect(secondCall?.stdout).toBe("pipe")
      expect(secondCall?.stderr).toBe("pipe")
    } finally {
      spawnSpy.mockRestore()
    }
  })

  test("POST telegram restart returns deterministic response when poll status read fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "telegram-settings-"))
    cleanupPaths.push(dir)
    const settingsPath = join(dir, "telegram-settings.json")
    const runtimeStatePath = join(dir, "telegram-runtime-state.json")

    process.env.TELEGRAM_SETTINGS_PATH = settingsPath
    process.env.TELEGRAM_RUNTIME_STATE_PATH = runtimeStatePath
    process.env.TELEGRAM_BRIDGE_APPLY_TIMEOUT_MS = "1200"
    process.env.TELEGRAM_BRIDGE_ALLOW_UNAUTH_RESTART = "true"

    const desired = readDesiredTelegramSettingsFingerprint()
    await writeFile(
      runtimeStatePath,
      JSON.stringify(
        {
          version: 1,
          appliedAt: new Date().toISOString(),
          pid: 222,
          mode: "polling",
          port: 4097,
          settingsFingerprint: `${desired}-old`,
        },
        null,
        2,
      ),
      "utf-8",
    )

    const spawnSpy = spyOn(Bun, "spawn").mockImplementation(() => {
      process.env.OPENCODE_API_URL = "not-a-url"
      return {
        exited: Promise.resolve(0),
        stdout: undefined,
        stderr: undefined,
        kill: () => undefined,
      } as unknown as ReturnType<typeof Bun.spawn>
    })
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("bridge unavailable")
    })

    try {
      const response = await handleExtendedEndpoint(
        "/api/ext/telegram/restart",
        "POST",
        new URL("http://127.0.0.1/api/ext/telegram/restart"),
        new Request("http://127.0.0.1/api/ext/telegram/restart", { method: "POST" }),
      )

      expect(response?.status).toBe(502)
      const data = await response?.json()
      expect(data.error).toBe("restart_unhealthy")
      expect(data.status).toBeNull()
    } finally {
      fetchSpy.mockRestore()
      spawnSpy.mockRestore()
    }
  })
})
