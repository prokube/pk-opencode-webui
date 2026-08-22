import { describe, expect, test } from "bun:test"
import type { QuestionRequest, Session } from "../src/sdk/client"
import { sessionQuestionRequest } from "../src/utils/session-tree-request"

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
})
