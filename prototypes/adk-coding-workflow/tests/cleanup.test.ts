import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { parseClaimRecord, writeClaimRecord, type WorkflowClaimRecord } from "../src/claim-record"
import { reconcileWorkflowClaim, type ClaimCleanupService } from "../src/cleanup"
import type { Issue } from "../src/domain"

const record: WorkflowClaimRecord = {
  version: 1,
  provider: "github",
  project: "prokube/pkui",
  number: 42,
  botLogin: "prokube-bot",
  runId: "workflow-42",
}

const claimedIssue = (overrides: Partial<Issue> = {}): Issue => ({
  number: 42,
  title: "Claimed issue",
  body: "",
  state: "open",
  labels: ["in-progress"],
  assignees: ["prokube-bot"],
  comments: [{ author: "prokube-bot", body: "Coding workflow `workflow-42` claimed this issue." }],
  openBlockers: [],
  url: "https://github.com/prokube/pkui/issues/42",
  ...overrides,
})

class FakeCleanupService implements ClaimCleanupService {
  login = "prokube-bot"
  issue = claimedIssue()
  pullRequest?: string
  issueReads = 0
  pullRequestChecks = 0
  releases: string[] = []
  releaseResult = true

  async getAuthenticatedLogin(): Promise<string> {
    return this.login
  }

  async getIssue(): Promise<Issue> {
    this.issueReads += 1
    return this.issue
  }

  async findPullRequest(): Promise<string | undefined> {
    this.pullRequestChecks += 1
    return this.pullRequest
  }

  async releaseIssueClaim(
    _repository: string,
    _issueNumber: number,
    _botLogin: string,
    _runId: string,
    reason: string,
  ): Promise<boolean> {
    this.releases.push(reason)
    return this.releaseResult
  }
}

describe("workflow claim cleanup", () => {
  test("releases an owned claim when the workflow failed without a pull request", async () => {
    const github = new FakeCleanupService()
    const outcome = await reconcileWorkflowClaim({
      record,
      expectedRunId: "workflow-42",
      workflowStatus: "Failed",
      result: { runId: "workflow-42", phase: "blocked" },
      github,
    })
    expect(outcome).toEqual({
      action: "released",
      reason: "workflow status Failed, result phase blocked",
    })
    expect(github.releases).toEqual(["workflow status Failed, result phase blocked"])
  })

  test("is a no-op before claim and for mismatched workflow or bot identity", async () => {
    const github = new FakeCleanupService()
    expect(await reconcileWorkflowClaim({
      expectedRunId: "workflow-42",
      workflowStatus: "Failed",
      github,
    })).toEqual({ action: "noop", reason: "No durable workflow claim record" })
    expect(await reconcileWorkflowClaim({
      record,
      expectedRunId: "another-run",
      workflowStatus: "Failed",
      github,
    })).toEqual({ action: "noop", reason: "Workflow claim record belongs to another run" })
    github.login = "another-bot"
    expect(await reconcileWorkflowClaim({
      record,
      expectedRunId: "workflow-42",
      workflowStatus: "Failed",
      github,
    })).toEqual({ action: "noop", reason: "Authenticated GitHub user does not own the workflow claim" })
    expect(github.issueReads).toBe(0)
    expect(github.releases).toEqual([])
  })

  test("does not release a conflicting claim", async () => {
    const github = new FakeCleanupService()
    github.issue = claimedIssue({
      assignees: ["prokube-bot", "human"],
    })
    const outcome = await reconcileWorkflowClaim({
      record,
      expectedRunId: "workflow-42",
      workflowStatus: "Failed",
      github,
    })
    expect(outcome).toEqual({ action: "noop", reason: "Issue has a conflicting assignee" })
    expect(github.pullRequestChecks).toBe(0)
    expect(github.releases).toEqual([])
  })

  test("reports a no-op when the claimed issue closes during reconciliation", async () => {
    const github = new FakeCleanupService()
    github.releaseResult = false
    const outcome = await reconcileWorkflowClaim({
      record,
      expectedRunId: "workflow-42",
      workflowStatus: "Failed",
      github,
    })
    expect(outcome).toEqual({ action: "noop", reason: "Claimed issue is no longer open" })
  })

  test("preserves claims with either a completed result or an existing pull request", async () => {
    const github = new FakeCleanupService()
    expect(await reconcileWorkflowClaim({
      record,
      expectedRunId: "workflow-42",
      workflowStatus: "Succeeded",
      result: {
        runId: "workflow-42",
        phase: "completed",
        pullRequestUrl: "https://github.com/prokube/pkui/pull/99",
      },
      github,
    })).toEqual({ action: "noop", reason: "Workflow result contains a completed pull request" })
    expect(github.pullRequestChecks).toBe(0)

    github.pullRequest = "https://github.com/prokube/pkui/pull/99"
    expect(await reconcileWorkflowClaim({
      record,
      expectedRunId: "workflow-42",
      workflowStatus: "Failed",
      github,
    })).toEqual({ action: "noop", reason: "A pull request already exists" })
    expect(github.releases).toEqual([])
  })

  test("writes the durable record idempotently and rejects replacement", async () => {
    const root = mkdtempSync(join(tmpdir(), "workflow-claim-"))
    const path = join(root, "nested", "claim.json")
    try {
      await writeClaimRecord(path, record)
      await writeClaimRecord(path, record)
      expect(parseClaimRecord(await Bun.file(path).text())).toEqual(record)
      await expect(writeClaimRecord(path, { ...record, number: 43 })).rejects.toThrow("conflicts")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
