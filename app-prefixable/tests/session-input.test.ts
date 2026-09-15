import { describe, expect, test } from "bun:test"
import { selectsSlashCommand } from "../src/utils/session-input"

describe("session input", () => {
  test("does not select slash commands with IME Enter or Tab", () => {
    expect(selectsSlashCommand("Enter", true)).toBe(false)
    expect(selectsSlashCommand("Tab", true)).toBe(false)
    expect(selectsSlashCommand("Enter", false)).toBe(true)
    expect(selectsSlashCommand("Tab", false)).toBe(true)
  })
})
