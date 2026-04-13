import { describe, expect, test } from "bun:test"
import { TELEGRAM_GUIDE_COMMANDS, TELEGRAM_GUIDE_REQUIRED_VARIABLES, TELEGRAM_GUIDE_SECTIONS, TELEGRAM_GUIDE_TITLE, TELEGRAM_READINESS_CHECKS } from "../src/components/telegram-setup-guide"
import { SETTINGS_BASE_TABS } from "../src/pages/settings-tabs"

describe("Telegram setup guide UI", () => {
  test("settings navigation includes telegram tab", () => {
    expect(SETTINGS_BASE_TABS).toContain("telegram")
  })

  test("guide exposes key sections and commands", () => {
    expect(TELEGRAM_GUIDE_TITLE).toBe("Telegram Setup Guide")
    expect(TELEGRAM_GUIDE_SECTIONS).toEqual(
      expect.arrayContaining(["Readiness checklist", "Setup steps", "Troubleshooting quick checks"]),
    )
    expect(TELEGRAM_GUIDE_COMMANDS).toContain("/notify on")
  })

  test("guide references required Telegram setup values", () => {
    expect(TELEGRAM_GUIDE_REQUIRED_VARIABLES).toEqual(
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
    expect(settings).toContain('<TelegramSettings serverUrl={basePath.serverUrl} />')
    expect(telegram).toContain("<TelegramSetupGuide />")
  })
})
