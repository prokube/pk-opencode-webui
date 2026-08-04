import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { ProcessResult, ProcessRunner } from "../src/process"
import { WorkspaceService, scrubGitHubEnvironment } from "../src/workspace"

class RecordingRunner implements ProcessRunner {
  readonly calls: Array<{ command: string[]; env?: Record<string, string | undefined> }> = []
  private staged = false

  async run(command: string[], options: { env?: Record<string, string | undefined> } = {}): Promise<ProcessResult> {
    this.calls.push({ command, env: options.env })
    if (command.includes("rev-parse")) return { exitCode: 0, stdout: "base-head\n", stderr: "" }
    if (command[0] === "git" && command[1] === "add") this.staged = true
    if (command.includes("--cached")) {
      return { exitCode: 0, stdout: this.staged ? "src/a.ts\0tests/a.test.ts\0" : "", stderr: "" }
    }
    if (command.includes("diff")) return { exitCode: 0, stdout: "src/a.ts\0", stderr: "" }
    if (command.includes("ls-files")) return { exitCode: 0, stdout: "tests/a.test.ts\0", stderr: "" }
    return { exitCode: 0, stdout: "", stderr: "" }
  }
}

describe("WorkspaceService", () => {
  test("uses an environment credential helper without placing the token in command arguments", async () => {
    const root = mkdtempSync(join(tmpdir(), "adk-workspace-"))
    const runner = new RecordingRunner()
    const workspace = new WorkspaceService(runner)
    try {
      const prepared = await workspace.prepare({
        repository: "prokube/pkui",
        issueNumber: 42,
        runId: "run-1",
        baseBranch: "main",
        workspaceRoot: root,
        token: "secret-token",
      })
      expect(prepared.branch).toBe("feature/issue-42")
      expect(prepared.baseHead).toBe("base-head")
      expect(runner.calls[0]?.command.join(" ")).not.toContain("secret-token")
      expect(runner.calls[0]?.env?.GH_TOKEN).toBe("secret-token")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("combines tracked and untracked changed files", async () => {
    const workspace = new WorkspaceService(new RecordingRunner())
    expect(await workspace.changedFiles("/tmp/worktree")).toEqual(["src/a.ts", "tests/a.test.ts"])
  })

  test("scrubs known GitHub credential variables", () => {
    expect(scrubGitHubEnvironment()).toEqual({
      GH_TOKEN: undefined,
      GITHUB_TOKEN: undefined,
      GITHUB_PAT: undefined,
    })
  })

  test("refuses to publish likely credential files", async () => {
    const workspace = new WorkspaceService(new RecordingRunner())
    await expect(workspace.commitAndPush({
      worktree: "/tmp/worktree",
      branch: "feature/issue-42",
      issue: {
        number: 42,
        title: "Issue",
        body: "",
        state: "open",
        labels: ["ready"],
        assignees: [],
        comments: [],
        openBlockers: [],
        url: "https://example.test",
      },
      changedFiles: ["config/.env.production"],
      token: "secret-token",
    })).rejects.toThrow("Refusing to publish sensitive paths")
  })

  test("rejects files staged before deterministic publication", async () => {
    class StagedRunner extends RecordingRunner {
      override async run(command: string[], options: { env?: Record<string, string | undefined> } = {}): Promise<ProcessResult> {
        if (command.includes("--cached")) return { exitCode: 0, stdout: ".env\0", stderr: "" }
        return super.run(command, options)
      }
    }
    const workspace = new WorkspaceService(new StagedRunner())
    await expect(workspace.changedFiles("/tmp/worktree")).rejects.toThrow("pre-staged files")
  })
})
