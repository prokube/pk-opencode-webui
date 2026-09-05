import { describe, expect, test } from "bun:test"
import type { QuestionRequest, Session } from "../src/sdk/client"
import { sessionQuestionRequest, sessionTreeIsWorking } from "../src/utils/session-tree-request"

const session = (id: string, parentID?: string) => ({ id, parentID }) as Session
const question = (id: string, sessionID: string) => ({ id, sessionID, questions: [] }) as QuestionRequest

describe("session question requests", () => {
  test("selects the current session question before descendant questions", () => {
    const own = question("que_own", "ses_root")
    const child = question("que_child", "ses_child")
    const sessions = [session("ses_root"), session("ses_child", "ses_root")]

    expect(sessionQuestionRequest(sessions, { ses_root: [own], ses_child: [child] }, "ses_root")).toBe(own)
  })

  test("surfaces queued questions from descendant sessions", () => {
    const first = question("que_first", "ses_grandchild")
    const second = question("que_second", "ses_grandchild")
    const sessions = [
      session("ses_root"),
      session("ses_child", "ses_root"),
      session("ses_grandchild", "ses_child"),
    ]

    expect(sessionQuestionRequest(sessions, { ses_grandchild: [first, second] }, "ses_root")).toBe(first)
  })

  test("aggregates busy and retrying descendant sessions", () => {
    const sessions = [
      session("ses_root"),
      session("ses_child", "ses_root"),
      session("ses_grandchild", "ses_child"),
    ]

    expect(sessionTreeIsWorking(sessions, { ses_grandchild: { type: "retry", attempt: 1, message: "wait", next: 1 } }, "ses_root")).toBe(true)
    expect(sessionTreeIsWorking(sessions, { ses_child: { type: "busy" } }, "ses_root")).toBe(true)
    expect(sessionTreeIsWorking(sessions, { ses_child: { type: "idle" } }, "ses_root")).toBe(false)
  })
})
