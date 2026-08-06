import { describe, expect, test } from "bun:test"

import { toPublicWorkflowResult } from "../src/report"

describe("toPublicWorkflowResult", () => {
  test("publishes a bounded successful result with a GitHub pull request", () => {
    expect(toPublicWorkflowResult({
      phase: "completed",
      summary: "Pull request created",
      branch: "feature/issue-42",
      pullRequestUrl: "https://github.com/prokube/pkui/pull/123",
      changedFiles: ["frontend/src/App.tsx"],
      workspace: "/workspace/private",
      sessionId: "private-session",
    })).toEqual({
      phase: "completed",
      summary: "Pull request created",
      branch: "feature/issue-42",
      pullRequestUrl: "https://github.com/prokube/pkui/pull/123",
      changedFiles: ["frontend/src/App.tsx"],
      changedFilesTruncated: false,
    })
  })

  test("rejects unsafe links and bounds changed files", () => {
    const result = toPublicWorkflowResult({
      phase: "completed",
      summary: "x".repeat(2_000),
      pullRequestUrl: "https://example.com/phishing",
      changedFiles: [...Array.from({ length: 101 }, (_, index) => `file-${index}`), "../secret"],
    })

    expect(result.summary).toHaveLength(1_000)
    expect(result.pullRequestUrl).toBeUndefined()
    expect(result.changedFiles).toHaveLength(100)
    expect(result.changedFilesTruncated).toBe(true)
  })

  test("redacts credential-shaped summaries", () => {
    const result = toPublicWorkflowResult({
      phase: "blocked",
      summary: "authorization: Bearer super-secret-value",
    })

    expect(result.summary).toBe("Result summary contained sensitive credential material and was redacted.")
  })

  test("reports missing internal results without failing the exit handler", () => {
    expect(toPublicWorkflowResult(undefined, "Failed")).toEqual({
      phase: "failed",
      summary: "Workflow ended with Argo status Failed before producing a result",
      changedFiles: [],
      changedFilesTruncated: false,
    })
  })
})
