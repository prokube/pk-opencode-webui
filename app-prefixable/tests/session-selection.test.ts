import { describe, expect, test } from "bun:test"
import type { Session } from "../src/sdk/client"
import { isSessionNotFound, mapWithConcurrency, selectSessionRange, selectedRootSessions, toggleSessionSelection } from "../src/utils/session-selection"

const session = (id: string, parentID?: string) => ({ id, parentID }) as Session

describe("session selection", () => {
  test("toggles and range-selects sessions", () => {
    expect([...toggleSessionSelection(new Set(["a"]), "a")]).toEqual([])
    expect([...selectSessionRange(new Set(), ["a", "b", "c"], "a", "c")]).toEqual(["a", "b", "c"])
  })

  test("omits selected descendants when their ancestor is selected", () => {
    const sessions = [session("root"), session("child", "root"), session("other")]
    expect(selectedRootSessions(sessions, new Set(["root", "child", "other"])).map((item) => item.id)).toEqual(["root", "other"])
  })

  test("limits concurrent batch work and preserves result order", async () => {
    let active = 0
    let peak = 0
    const result = await mapWithConcurrency([1, 2, 3, 4], 2, async (value) => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 1))
      active -= 1
      return value * 2
    })
    expect(peak).toBe(2)
    expect(result).toEqual([2, 4, 6, 8])
  })

  test("recognizes idempotent not-found results", () => {
    expect(isSessionNotFound({ name: "NotFound" })).toBe(true)
    expect(isSessionNotFound({ name: "NotFoundError" })).toBe(true)
    expect(isSessionNotFound({ status: 404 })).toBe(true)
    expect(isSessionNotFound(new Error("network"))).toBe(false)
  })
})
