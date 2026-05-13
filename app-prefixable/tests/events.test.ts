import { describe, expect, test } from "bun:test"
import { sessionStatusEvent } from "../src/context/events"

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
})
