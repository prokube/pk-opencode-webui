import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { handleExtendedEndpoint } from "../../shared/extended-api"

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
      ]),
    )
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
          },
        }),
      }),
    )

    expect(update?.status).toBe(200)
    const updateData = await update?.json()
    expect(updateData.changedFields).toEqual(
      expect.arrayContaining(["token", "openCodeUrl", "notificationDebounceMs"]),
    )
    expect(updateData.restartRequired).toBe(true)
    expect(updateData.restartRequiredFields).toEqual(
      expect.arrayContaining(["token", "openCodeUrl", "notificationDebounceMs"]),
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
    expect(readData.settings.token).toBeUndefined()
    expect(readData.metadata.runtimeReloadableFields).toEqual([])
    expect(readData.metadata.restartRequiredFields).toContain("token")

    const stored = JSON.parse(await Bun.file(path).text()) as {
      settings?: Record<string, string | number>
    }
    expect(stored.settings?.token).toBe("persisted-secret-token")
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
      settings?: Record<string, string | number>
    }
    expect(stored.settings?.token).toBeUndefined()
    expect(stored.settings?.openCodeUrl).toBeUndefined()
    expect(stored.settings?.sessionCacheMax).toBeUndefined()
    expect(stored.settings?.port).toBeUndefined()
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
})
