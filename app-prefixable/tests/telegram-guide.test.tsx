import { describe, expect, test } from "bun:test"
import { TELEGRAM_GUIDE_COMMANDS, TELEGRAM_GUIDE_SECTIONS, TELEGRAM_GUIDE_TITLE, TELEGRAM_READINESS_CHECKS } from "../src/components/telegram-setup-guide"
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

  test("guide constants include expected quick checks", () => {
    expect(TELEGRAM_GUIDE_COMMANDS).toEqual(expect.arrayContaining(["/new", "/status", "/help", "/notify status"]))
    expect(TELEGRAM_READINESS_CHECKS.length).toBeGreaterThanOrEqual(5)
    expect(TELEGRAM_READINESS_CHECKS.some((item) => item.id === "webhook")).toBe(true)
  })

  test("readiness checklist export is immutable", () => {
    expect(Object.isFrozen(TELEGRAM_READINESS_CHECKS)).toBe(true)
    expect(TELEGRAM_READINESS_CHECKS.every((item) => Object.isFrozen(item))).toBe(true)
  })
})
