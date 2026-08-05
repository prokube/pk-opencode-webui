import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { ProcessResult, ProcessRunner } from "../src/process"
import { WorkspaceService, scrubGitHubEnvironment } from "../src/workspace"

class RecordingRunner implements ProcessRunner {
  readonly calls: Array<{
    command: string[]
    env?: Record<string, string | undefined>
    cleanEnv?: boolean
  }> = []
  protected staged = false

  async run(command: string[], options: {
    env?: Record<string, string | undefined>
    cleanEnv?: boolean
  } = {}): Promise<ProcessResult> {
    this.calls.push({ command, env: options.env, cleanEnv: options.cleanEnv })
    if (command.includes("--show-current")) return { exitCode: 0, stdout: "feature/issue-42\n", stderr: "" }
    if (command.includes("get-url")) {
      return { exitCode: 0, stdout: "https://github.com/prokube/pkui.git\n", stderr: "" }
    }
    if (command.includes("rev-parse")) return { exitCode: 0, stdout: "base-head\n", stderr: "" }
    if (command[0] === "git" && command[1] === "add") this.staged = true
    if (command[0] === "git" && command[1] === "reset") this.staged = false
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
      repository: "prokube/pkui",
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

  test("opens only the expected issue branch from an existing workflow", async () => {
    const workspace = new WorkspaceService(new RecordingRunner())
    const prepared = await workspace.openExisting({
      issueNumber: 42,
      runId: "workflow-run-1",
      workspaceRoot: "/workspace/.data/workspaces",
    })
    expect(prepared).toMatchObject({
      branch: "feature/issue-42",
      baseHead: "base-head",
      worktree: "/workspace/.data/workspaces/workflow-run-1/worktree",
    })
  })

  test("rejects unsafe workflow run IDs", async () => {
    const workspace = new WorkspaceService(new RecordingRunner())
    await expect(workspace.openExisting({
      issueNumber: 42,
      runId: "../another-run",
      workspaceRoot: "/workspace/.data/workspaces",
    })).rejects.toThrow("Invalid workflow run ID")
  })

  test("binds attestations to the digest emitted by validation", async () => {
    const workspace = new WorkspaceService(new RecordingRunner())
    const patchSha256 = createHash("sha256").update("src/a.ts\0").digest("hex")
    const attestation = await workspace.createAttestation({
      issueNumber: 42,
      runId: "workflow-run-1",
      workspaceRoot: "/workspace/.data/workspaces",
      expectedPatchSha256: patchSha256,
    })
    expect(attestation).toMatchObject({ patchSha256, changedFiles: ["src/a.ts", "tests/a.test.ts"] })
    await expect(new WorkspaceService(new RecordingRunner()).createAttestation({
      issueNumber: 42,
      runId: "workflow-run-1",
      workspaceRoot: "/workspace/.data/workspaces",
      expectedPatchSha256: "0".repeat(64),
    })).rejects.toThrow("Validated patch digest does not match")
  })

  test("clears interrupted staging before verifying an attested worktree", async () => {
    const root = mkdtempSync(join(tmpdir(), "adk-attestation-retry-"))
    const baseHead = "a".repeat(40)
    const patch = "src/a.ts\0"
    const patchSha256 = createHash("sha256").update(patch).digest("hex")
    class InterruptedRunner extends RecordingRunner {
      constructor() {
        super()
        this.staged = true
      }

      override async run(command: string[], options: {
        env?: Record<string, string | undefined>
        cleanEnv?: boolean
      } = {}): Promise<ProcessResult> {
        if (command.includes("rev-parse")) return { exitCode: 0, stdout: `${baseHead}\n`, stderr: "" }
        return super.run(command, options)
      }
    }
    const runner = new InterruptedRunner()
    const runRoot = join(root, "workflow-run-1")
    mkdirSync(runRoot, { recursive: true })
    writeFileSync(join(runRoot, "validation.json"), JSON.stringify({
      version: 1,
      runId: "workflow-run-1",
      issueNumber: 42,
      branch: "feature/issue-42",
      baseHead,
      changedFiles: ["src/a.ts", "tests/a.test.ts"],
      patchSha256,
    }))
    try {
      const verified = await new WorkspaceService(runner).verifyAttestation({
        issueNumber: 42,
        runId: "workflow-run-1",
        workspaceRoot: root,
      })
      expect(verified.changedFiles).toEqual(["src/a.ts", "tests/a.test.ts"])
      expect(runner.calls.some((call) => call.command.includes("reset"))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("disables hooks, verifies the push URL, and limits token exposure", async () => {
    const runner = new RecordingRunner()
    const workspace = new WorkspaceService(runner)
    await workspace.commitAndPush({
      repository: "prokube/pkui",
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
      changedFiles: ["src/a.ts", "tests/a.test.ts"],
      token: "secret-token",
      baseHead: "base-head",
    })
    expect(runner.calls.some((call) => call.command.includes("--push") && call.command.includes("get-url"))).toBe(true)
    const push = runner.calls.find((call) => call.command.includes("push") && !call.command.includes("get-url"))
    expect(push?.command).toContain("core.hooksPath=/dev/null")
    expect(push?.env?.GH_TOKEN).toBe("secret-token")
    expect(push?.cleanEnv).toBe(true)
    for (const call of runner.calls.filter((candidate) => candidate !== push && !candidate.command.includes("ls-remote"))) {
      expect(call.env?.GH_TOKEN).toBeUndefined()
    }
  })

  test("refuses to export likely credential files", async () => {
    const workspace = new WorkspaceService(new RecordingRunner())
    await expect(workspace.createPatch("/tmp/worktree", ["credentials/token.txt"]))
      .rejects.toThrow("Refusing to export sensitive paths")
  })

  test("refuses to export an empty change set", async () => {
    const workspace = new WorkspaceService(new RecordingRunner())
    await expect(workspace.createPatch("/tmp/worktree", []))
      .rejects.toThrow("No changed files to export")
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
