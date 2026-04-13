import { describe, expect, test } from "bun:test"
import { createTelegramForm, createTelegramPatch, validateTelegramForm, type TelegramPublicSettings } from "../src/utils/telegram-settings"

const seed: TelegramPublicSettings = {
  mode: "polling",
  tokenConfigured: true,
  tokenSource: "persisted",
  openCodeUrl: "http://127.0.0.1:4096/",
  directory: null,
  sessionCacheMax: 500,
  sessionCacheTtlMs: 60000,
  notificationDebounceMs: 20000,
  port: 4097,
  webhookPath: "/webhook",
  webhookSecretConfigured: false,
  webhookSecretSource: "none",
  webhookUrl: null,
  sessionStorePath: "/tmp/opencode-telegram-sessions.json",
  sessionLinkBase: null,
}

describe("telegram settings form helpers", () => {
  test("builds patch for happy-path changes", () => {
    const initial = createTelegramForm(seed)
    const next = {
      ...initial,
      mode: "webhook" as const,
      openCodeUrl: "https://api.example.com",
      tokenMode: "set" as const,
      token: "new-token",
    }

    const patch = createTelegramPatch(next, initial)
    expect(patch).toEqual({
      mode: "webhook",
      openCodeUrl: "https://api.example.com",
      token: "new-token",
    })
  })

  test("returns validation errors for invalid values", () => {
    const form = {
      ...createTelegramForm(seed),
      openCodeUrl: "not-a-url",
      port: "99999",
      sessionCacheMax: "0",
      webhookPath: "webhook",
      tokenMode: "set" as const,
      token: "",
    }

    const errors = validateTelegramForm(form)
    expect(errors.openCodeUrl).toBe("Enter a valid URL")
    expect(errors.port).toBe("Must be an integer between 1 and 65535")
    expect(errors.sessionCacheMax).toBe("Must be a positive integer")
    expect(errors.webhookPath).toBeUndefined()
    expect(errors.token).toBe("Token is required when setting a new value")
  })

  test("normalizes webhook path patch values to include leading slash", () => {
    const initial = createTelegramForm(seed)
    const next = {
      ...initial,
      webhookPath: "hooks/new",
    }

    const patch = createTelegramPatch(next, initial)
    expect(patch.webhookPath).toBe("/hooks/new")
  })

  test("does not emit webhook patch when only slash differs", () => {
    const initial = createTelegramForm(seed)
    const next = {
      ...initial,
      webhookPath: "webhook",
    }

    const patch = createTelegramPatch(next, initial)
    expect(patch.webhookPath).toBeUndefined()
  })

  test("creates clear patch for secret and optional fields", () => {
    const initial = createTelegramForm({ ...seed, webhookUrl: "https://hooks.example.com" })
    const next = {
      ...initial,
      tokenMode: "clear" as const,
      webhookUrl: "",
    }

    const patch = createTelegramPatch(next, initial)
    expect(patch).toEqual({
      token: null,
      webhookUrl: null,
    })
  })

  test("allows blank values to clear persisted URL and numeric overrides", () => {
    const initial = createTelegramForm(seed)
    const next = {
      ...initial,
      openCodeUrl: "",
      sessionCacheMax: "",
      sessionCacheTtlMs: "",
      notificationDebounceMs: "",
      port: "",
    }

    const errors = validateTelegramForm(next)
    expect(errors.openCodeUrl).toBeUndefined()
    expect(errors.sessionCacheMax).toBeUndefined()
    expect(errors.sessionCacheTtlMs).toBeUndefined()
    expect(errors.notificationDebounceMs).toBeUndefined()
    expect(errors.port).toBeUndefined()

    const patch = createTelegramPatch(next, initial)
    expect(patch).toEqual({
      openCodeUrl: null,
      sessionCacheMax: null,
      sessionCacheTtlMs: null,
      notificationDebounceMs: null,
      port: null,
    })
  })
})
