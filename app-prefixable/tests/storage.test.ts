import { describe, expect, test } from "bun:test"
import { legacyStorageValue, serverStorageKey, workspaceStorageKey } from "../src/utils/storage"

describe("scoped storage", () => {
  test("builds stable server and workspace keys", () => {
    expect(serverStorageKey("local", "sidebarExpanded")).toBe("opencode.server.local.sidebarExpanded")
    expect(workspaceStorageKey("local", "/work/project", "lastSession")).toBe(
      "opencode.server.local.workspace.%2Fwork%2Fproject.lastSession",
    )
  })

  test("encodes special characters in directories", () => {
    expect(workspaceStorageKey("local", "/work/a b/#demo", "layout")).toBe(
      "opencode.server.local.workspace.%2Fwork%2Fa%20b%2F%23demo.layout",
    )
  })

  test("selects valid legacy data only for an empty local scope", () => {
    const valid = (value: string) => value === "valid"
    expect(legacyStorageValue("local", null, ["invalid", "valid"], valid)).toEqual({
      value: "valid",
      migrated: true,
    })
    expect(legacyStorageValue("local", "current", ["valid"], valid)).toEqual({
      value: "current",
      migrated: false,
    })
  })
})
