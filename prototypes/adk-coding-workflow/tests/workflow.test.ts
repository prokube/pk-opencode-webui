import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { runWithAdk } from "../src/adk-agent"
import type { Issue, WorkflowRequest } from "../src/domain"
import type { GitHubService } from "../src/github"
import type { OpenCodeService } from "../src/opencode"
import type { ProcessResult, ProcessRunner } from "../src/process"
import { RunStore } from "../src/store"
import { CodingWorkflow } from "../src/workflow"
import { WorkspaceService } from "../src/workspace"

const readyIssue: Issue = {
  number: 42,
  title: "Implement the prototype",
  body: "Acceptance criteria",
  state: "open",
  labels: ["ready"],
  assignees: [],
  comments: [],
  openBlockers: [],
  url: "https://github.com/prokube/example/issues/42",
}

class FakeGitHub implements GitHubService {
  claims = 0
  pullRequests = 0
  existingPullRequest?: string

  async getIssue(): Promise<Issue> {
    return readyIssue
  }

  async claimIssue(): Promise<void> {
    this.claims += 1
  }

  async findOpenPullRequest(): Promise<string | undefined> {
    return this.existingPullRequest
  }

  async createPullRequest(): Promise<string> {
    this.pullRequests += 1
    return "https://github.com/prokube/example/pull/1"
  }

  async comment(): Promise<void> {}
}

class FakeRunner implements ProcessRunner {
  private staged = false

  async run(command: string[]): Promise<ProcessResult> {
    if (command.includes("rev-parse")) return { exitCode: 0, stdout: "base-head\n", stderr: "" }
    if (command[0] === "git" && command[1] === "add") this.staged = true
    if (command.includes("--cached")) {
      return { exitCode: 0, stdout: this.staged ? "src/prototype.ts\0" : "", stderr: "" }
    }
    if (command.includes("diff")) return { exitCode: 0, stdout: "src/prototype.ts\0", stderr: "" }
    return { exitCode: 0, stdout: "", stderr: "" }
  }
}

const request = (root: string, mode: WorkflowRequest["mode"]): WorkflowRequest => ({
  repository: "prokube/example",
  issueNumber: 42,
  mode,
  baseBranch: "main",
  workspaceRoot: root,
  validationCommands: ["bun test"],
  botLogin: "prokube-bot",
})

describe("CodingWorkflow through ADK", () => {
  test("plan mode validates eligibility without claiming or running OpenCode", async () => {
    const root = mkdtempSync(join(tmpdir(), "adk-plan-"))
    const store = new RunStore(":memory:")
    const github = new FakeGitHub()
    let calls = 0
    const opencode: OpenCodeService = {
      async implement() {
        calls += 1
        return { status: "completed", sessionId: "session" }
      },
    }
    try {
      const workflow = new CodingWorkflow(store, github, new WorkspaceService(new FakeRunner()), opencode)
      const result = await runWithAdk(workflow, request(root, "plan"))
      expect(result.phase).toBe("completed")
      expect(github.claims).toBe(0)
      expect(calls).toBe(0)
    } finally {
      store.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("execute mode runs OpenCode and validation without publishing", async () => {
    const root = mkdtempSync(join(tmpdir(), "adk-execute-"))
    const store = new RunStore(":memory:")
    const github = new FakeGitHub()
    const opencode: OpenCodeService = {
      async implement() {
        return { status: "completed", sessionId: "session-1" }
      },
    }
    try {
      const workflow = new CodingWorkflow(store, github, new WorkspaceService(new FakeRunner()), opencode)
      const result = await runWithAdk(workflow, request(root, "execute"))
      expect(result).toMatchObject({
        phase: "completed",
        branch: "feature/issue-42",
        sessionId: "session-1",
        changedFiles: ["src/prototype.ts"],
      })
      expect(github.claims).toBe(0)
      expect(github.pullRequests).toBe(0)
    } finally {
      store.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("publish mode claims and creates a PR only after implementation", async () => {
    const root = mkdtempSync(join(tmpdir(), "adk-publish-"))
    const store = new RunStore(":memory:")
    const github = new FakeGitHub()
    const opencode: OpenCodeService = {
      async implement() {
        return { status: "completed", sessionId: "session-2" }
      },
    }
    try {
      const workflow = new CodingWorkflow(store, github, new WorkspaceService(new FakeRunner()), opencode, "secret-token")
      const result = await runWithAdk(workflow, request(root, "publish"))
      expect(result.pullRequestUrl).toBe("https://github.com/prokube/example/pull/1")
      expect(github.claims).toBe(1)
      expect(github.pullRequests).toBe(1)
    } finally {
      store.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("publish mode does not duplicate an existing pull request", async () => {
    const root = mkdtempSync(join(tmpdir(), "adk-existing-pr-"))
    const store = new RunStore(":memory:")
    const github = new FakeGitHub()
    github.existingPullRequest = "https://github.com/prokube/example/pull/7"
    let calls = 0
    const opencode: OpenCodeService = {
      async implement() {
        calls += 1
        return { status: "completed", sessionId: "session-3" }
      },
    }
    try {
      const workflow = new CodingWorkflow(store, github, new WorkspaceService(new FakeRunner()), opencode, "secret-token")
      const result = await runWithAdk(workflow, request(root, "publish"))
      expect(result).toMatchObject({
        phase: "blocked",
        pullRequestUrl: "https://github.com/prokube/example/pull/7",
      })
      expect(github.claims).toBe(0)
      expect(calls).toBe(0)
    } finally {
      store.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
