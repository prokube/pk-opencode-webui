import { describe, expect, test } from "bun:test"

import {
  branchForIssue,
  evaluateEligibility,
  reviewRunKey,
  validateRepository,
  type Issue,
} from "../src/domain"

const issue = (overrides: Partial<Issue> = {}): Issue => ({
  number: 42,
  title: "Implement a safe workflow",
  body: "Body",
  state: "open",
  labels: ["ready"],
  assignees: [],
  comments: [],
  openBlockers: [],
  url: "https://github.com/prokube/example/issues/42",
  ...overrides,
})

describe("issue eligibility", () => {
  test("accepts an unassigned ready issue without blockers", () => {
    expect(evaluateEligibility(issue())).toEqual({ eligible: true })
  })

  test.each([
    [issue({ state: "closed" }), "Issue is not open"],
    [issue({ labels: [] }), "Issue is not labeled ready"],
    [issue({ labels: ["ready", "in-progress"] }), "Issue is already in progress"],
    [issue({ labels: ["ready", "needs-discussion"] }), "Issue needs discussion"],
    [issue({ assignees: ["worker"] }), "Issue already has an assignee"],
  ])("rejects ineligible state", (input, reason) => {
    expect(evaluateEligibility(input)).toEqual({ eligible: false, reason })
  })

  test("lists open blockers in the rejection", () => {
    expect(evaluateEligibility(issue({ openBlockers: [{ number: 7, title: "Prerequisite" }] }))).toEqual({
      eligible: false,
      reason: "Issue is blocked by #7",
    })
  })
})

describe("stable workflow identifiers", () => {
  test("creates issue branches and correlation keys", () => {
    expect(branchForIssue(42)).toBe("feature/issue-42")
    expect(reviewRunKey("prokube/pkui", 99, 2)).toBe("prokube/pkui!99/remediation-2")
  })

  test("rejects repository strings that could alter URLs or paths", () => {
    expect(() => validateRepository("prokube/pkui; rm -rf /")).toThrow("Invalid GitHub repository")
  })
})
