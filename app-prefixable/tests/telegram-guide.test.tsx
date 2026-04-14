import { describe, expect, test } from "bun:test"
import { TELEGRAM_GUIDE_COMMANDS, TELEGRAM_GUIDE_REQUIRED_KEYS, TELEGRAM_GUIDE_SECTIONS, TELEGRAM_GUIDE_TITLE, TELEGRAM_READINESS_CHECKS } from "../src/components/telegram-setup-guide"
import { SETTINGS_BASE_TABS } from "../src/pages/settings-tabs"

describe("Telegram setup guide UI", () => {
  test("settings navigation includes telegram tab", () => {
    expect(SETTINGS_BASE_TABS).toContain("telegram")
  })

  test("guide exposes key sections and commands", () => {
    expect(TELEGRAM_GUIDE_TITLE).toMatch(/telegram setup guide/i)
    expect(TELEGRAM_GUIDE_SECTIONS.some((item) => /readiness checklist/i.test(item))).toBe(true)
    expect(TELEGRAM_GUIDE_SECTIONS.some((item) => /setup steps/i.test(item))).toBe(true)
    expect(TELEGRAM_GUIDE_SECTIONS.some((item) => /troubleshooting quick checks/i.test(item))).toBe(true)
    expect(TELEGRAM_GUIDE_COMMANDS.some((item) => /^\/notify\s+on$/i.test(item))).toBe(true)
  })

  test("guide references required Telegram setup values", () => {
    expect(TELEGRAM_GUIDE_REQUIRED_KEYS).toEqual(
      expect.arrayContaining(["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "openCodeUrl", "webhookUrl"]),
    )
  })

  test("guide constants include expected quick checks", () => {
    expect(TELEGRAM_GUIDE_COMMANDS).toEqual(expect.arrayContaining(["/new", "/status", "/help", "/notify status"]))
    expect(TELEGRAM_READINESS_CHECKS.length).toBeGreaterThanOrEqual(5)
    expect(TELEGRAM_READINESS_CHECKS.some((item) => item.id === "webhook")).toBe(true)
  })

  test("readiness checklist export is immutable", () => {
    expect(Object.isFrozen(TELEGRAM_READINESS_CHECKS)).toBe(true)
    expect(TELEGRAM_READINESS_CHECKS.every((item) => Object.isFrozen(item))).toBe(true)
  })

  test("settings telegram tab keeps setup guide mounted", async () => {
    const settings = await Bun.file(new URL("../src/pages/settings.tsx", import.meta.url)).text()
    const telegram = await Bun.file(new URL("../src/components/telegram-settings.tsx", import.meta.url)).text()
    expect(settings).toMatch(/<TelegramSettings\s+serverUrl=\{basePath\.serverUrl\}\s*\/>/)
    expect(telegram).toMatch(/<TelegramSetupGuide\s*\/>/)
  })
})
