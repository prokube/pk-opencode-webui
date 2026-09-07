import { describe, expect, test } from "bun:test"
import { filterPaletteEntries, paletteQuery, type PaletteEntry } from "../src/utils/command-palette"

const entry = (id: string, category: PaletteEntry["category"], title: string, description?: string): PaletteEntry => ({
  id, category, title, description, run: () => undefined,
})

describe("command palette", () => {
  const entries = [
    entry("command:new", "command", "New Session"),
    entry("session:one", "session", "Fix deployment", "Project Alpha"),
    entry("project:one", "project", "Alpha", "/work/alpha"),
  ]

  test("parses category prefixes", () => {
    expect(paletteQuery("> new")).toEqual({ category: "command", text: "new" })
    expect(paletteQuery("@fix")).toEqual({ category: "session", text: "fix" })
    expect(paletteQuery("# alpha")).toEqual({ category: "project", text: "alpha" })
  })

  test("filters titles, descriptions, and categories", () => {
    expect(filterPaletteEntries(entries, "alpha").map((item) => item.id)).toEqual(["project:one", "session:one"])
    expect(filterPaletteEntries(entries, ">new").map((item) => item.id)).toEqual(["command:new"])
  })
})
