import { describe, expect, test } from "bun:test"
import { sessionStatusEvent } from "../src/context/events"
import { nextSSEReconnectDelay } from "../src/utils/sse"

describe("sessionStatusEvent", () => {
  test("normalizes session.status events", () => {
    expect(sessionStatusEvent({
      type: "session.status",
      properties: { sessionID: "ses_1", status: { type: "busy" } },
    })).toEqual({ sessionID: "ses_1", status: { type: "busy" } })
  })

  test("normalizes session.idle events", () => {
    expect(sessionStatusEvent({
      type: "session.idle",
      properties: { sessionID: "ses_1" },
    })).toEqual({ sessionID: "ses_1", status: { type: "idle" } })
  })

  test("ignores unrelated events", () => {
    expect(sessionStatusEvent({ type: "message.updated", properties: {} })).toBeUndefined()
  })

  test("immediate SSE close backs off reconnects", () => {
    expect(nextSSEReconnectDelay(Date.now(), Date.now(), 3000)).toBe(6000)
    expect(nextSSEReconnectDelay(Date.now(), Date.now(), 30_000)).toBe(30_000)
  })
})
