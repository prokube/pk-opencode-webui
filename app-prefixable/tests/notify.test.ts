import { describe, expect, test } from "bun:test"
import {
  migrateNotifySessionKey,
  notifyEnabledForSession,
  writeNotifySessionEnabled,
} from "../src/utils/notify"

describe("notify storage compatibility", () => {
  test("reads legacy and scoped keys", () => {
    const map = {
      "session-legacy": true,
      "/workspace/project::session-scoped": true,
    }
    expect(notifyEnabledForSession(map, "session-legacy", "/workspace/project")).toBe(true)
    expect(notifyEnabledForSession(map, "session-scoped", "/workspace/project")).toBe(true)
  })

  test("migrates legacy key into scoped key", () => {
    const map = { "session-a": true }
    expect(migrateNotifySessionKey(map, "session-a", "/workspace/project")).toBe(true)
    expect(map["session-a"]).toBeUndefined()
    expect(map["/workspace/project::session-a"]).toBe(true)
  })

  test("writes scoped key and clears legacy key", () => {
    const map = { "session-a": true }
    writeNotifySessionEnabled(map, "session-a", true, "/workspace/project")
    expect(map["session-a"]).toBeUndefined()
    expect(map["/workspace/project::session-a"]).toBe(true)

    writeNotifySessionEnabled(map, "session-a", false, "/workspace/project")
    expect(map["session-a"]).toBeUndefined()
    expect(map["/workspace/project::session-a"]).toBeUndefined()
  })
})
