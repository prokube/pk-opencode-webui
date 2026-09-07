import { describe, expect, test } from "bun:test"
import { ptyRemoveSucceeded } from "../src/context/terminal"

describe("terminal state", () => {
  test("drops a PTY only after removal or an idempotent not-found response", () => {
    expect(ptyRemoveSucceeded({ data: true, response: { status: 200 } })).toBe(true)
    expect(ptyRemoveSucceeded({ response: { status: 404 } })).toBe(true)
    expect(ptyRemoveSucceeded({ data: false, response: { status: 200 } })).toBe(false)
    expect(ptyRemoveSucceeded({ response: { status: 500 } })).toBe(false)
  })
})
