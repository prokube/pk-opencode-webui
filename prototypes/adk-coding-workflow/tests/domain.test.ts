import { describe, expect, test } from "bun:test"

import {
  branchForIssue,
  evaluateEligibility,
  evaluateWorkflowClaim,
  reviewRunKey,
  validateBranch,
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
    [issue({ labels: ["ready", "needs-supervisor"] }), "Issue needs supervisor attention"],
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

  test("accepts only a complete claim owned by the same workflow", () => {
    const claimed = issue({
      labels: ["in-progress"],
      assignees: ["prokube-bot"],
      comments: [{ author: "prokube-bot", body: "Coding workflow `run-42` claimed this issue." }],
    })
    expect(evaluateWorkflowClaim(claimed, "prokube-bot", "run-42")).toEqual({ eligible: true })
    expect(evaluateWorkflowClaim({ ...claimed, labels: ["ready", "in-progress"] }, "prokube-bot", "run-42"))
      .toEqual({ eligible: false, reason: "Workflow claim is incomplete" })
  })

  test("rejects foreign workflow markers and assignees", () => {
    expect(evaluateWorkflowClaim(issue({
      labels: ["in-progress"],
      assignees: ["prokube-bot"],
      comments: [{ author: "prokube-bot", body: "Coding workflow `other-run` claimed this issue." }],
    }), "prokube-bot", "run-42")).toEqual({
      eligible: false,
      reason: "Issue has a conflicting workflow claim",
    })
    expect(evaluateWorkflowClaim(issue({
      labels: ["in-progress"],
      assignees: ["prokube-bot", "another-user"],
      comments: [{ author: "prokube-bot", body: "Coding workflow `run-42` claimed this issue." }],
    }), "prokube-bot", "run-42")).toEqual({
      eligible: false,
      reason: "Issue has a conflicting assignee",
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

  test("accepts normal base branches and rejects revision syntax", () => {
    expect(validateBranch("feature/target")).toBe("feature/target")
    expect(() => validateBranch("main^{commit}")).toThrow("Invalid Git branch")
  })
})
