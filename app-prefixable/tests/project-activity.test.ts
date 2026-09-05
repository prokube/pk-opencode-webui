import { describe, expect, test } from "bun:test"
import { completedSessionIDs, projectActivityBadge, reduceProjectActivity, reduceProjectRequests } from "../src/context/project-activity"

describe("project activity", () => {
  test("tracks status and idle events per directory", () => {
    const busy = reduceProjectActivity({}, "/one", {
      type: "session.status",
      properties: { sessionID: "ses_1", status: { type: "busy" } },
    })
    const other = reduceProjectActivity(busy, "/two", {
      type: "session.status",
      properties: { sessionID: "ses_2", status: { type: "retry", attempt: 1, message: "wait", next: 1 } },
    })
    const idle = reduceProjectActivity(other, "/one", {
      type: "session.idle",
      properties: { sessionID: "ses_1" },
    })

    expect(idle["/one"].ses_1).toEqual({ type: "idle" })
    expect(idle["/two"].ses_2.type).toBe("retry")
  })

  test("removes deleted sessions", () => {
    const state = { "/one": { ses_1: { type: "busy" as const } } }
    const next = reduceProjectActivity(state, "/one", {
      type: "session.deleted",
      properties: { info: { id: "ses_1" } },
    })

    expect(next["/one"]).toEqual({})
  })

  test("ignores unrelated events", () => {
    const state = { "/one": { ses_1: { type: "busy" as const } } }
    expect(reduceProjectActivity(state, "/one", {
      type: "message.part.updated",
      properties: { sessionID: "ses_1" },
    })).toBe(state)
  })

  test("prioritizes permissions, then questions, then running sessions", () => {
    const statuses = { ses_1: { type: "busy" as const }, ses_2: { type: "retry" as const, attempt: 1, message: "wait", next: 1 } }
    expect(projectActivityBadge(statuses, 2, 3)).toEqual({ type: "permission", count: 3 })
    expect(projectActivityBadge(statuses, 2, 0)).toEqual({ type: "question", count: 2 })
    expect(projectActivityBadge(statuses, 0, 0)).toEqual({ type: "working", count: 2 })
  })

  test("detects background sessions that stopped working", () => {
    const previous = {
      done: { type: "busy" as const },
      retrying: { type: "retry" as const, attempt: 1, message: "wait", next: 1 },
      idle: { type: "idle" as const },
    }
    const next = {
      retrying: { type: "busy" as const },
      idle: { type: "idle" as const },
    }
    expect(completedSessionIDs(previous, next)).toEqual(["done"])
  })

  test("tracks question requests by directory and request ID", () => {
    const first = reduceProjectRequests({}, "/one", {
      type: "question.asked",
      properties: { id: "question-1", sessionID: "session-1" },
    }, "question")
    const second = reduceProjectRequests(first, "/one", {
      type: "question.asked",
      properties: { id: "question-2", sessionID: "session-1" },
    }, "question")
    const replied = reduceProjectRequests(second, "/one", {
      type: "question.replied",
      properties: { requestID: "question-1", sessionID: "session-1" },
    }, "question")

    expect(replied["/one"]).toEqual({ "question-2": "session-1" })
  })

  test("removes session requests when the session is deleted", () => {
    const state = { "/one": { "permission-1": "session-1", "permission-2": "session-2" } }
    const next = reduceProjectRequests(state, "/one", {
      type: "session.deleted",
      properties: { info: { id: "session-1" } },
    }, "permission")

    expect(next["/one"]).toEqual({ "permission-2": "session-2" })
  })
})
