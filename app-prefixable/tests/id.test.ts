import { describe, expect, test } from "bun:test"
import { ascendingID } from "../src/utils/id"

describe("ascendingID", () => {
  test("creates protocol-prefixed IDs in monotonic lexical order", () => {
    const first = ascendingID("msg", 1_000)
    const second = ascendingID("msg", 1_000)
    const later = ascendingID("msg", 1_001)

    expect(first).toMatch(/^msg_[0-9a-f]{16}[0-9A-Za-z]{14}$/)
    expect(first < second).toBe(true)
    expect(second < later).toBe(true)
  })

  test("remains monotonic when timestamps move backward", () => {
    const first = ascendingID("msg", Date.now())
    const second = ascendingID("msg", 1)

    expect(first < second).toBe(true)
  })
})
