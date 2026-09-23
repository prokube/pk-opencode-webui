import { createHash } from "node:crypto"
import { mkdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"

import type { Issue } from "./domain"
import { branchForIssue } from "./domain"
import type { ProcessRunner } from "./process"
import { requireSuccess } from "./process"

const credentialHelper = '!f() { test -n "$GH_TOKEN" && echo username=x-access-token && echo password="$GH_TOKEN"; }; f'
const sensitivePath = /(^|\/)\.env(?:\.|$)|(^|\/)(id_rsa|id_ed25519|credentials?|secrets?)(\/|$)|\.(pem|key|p12)$/i

export type PreparedWorkspace = {
  root: string
  source: string
  worktree: string
  branch: string
  baseHead: string
}

export type WorkspaceAttestation = {
  version: 1
  runId: string
  issueNumber: number
  branch: string
  baseHead: string
  changedFiles: string[]
  patchSha256: string
}

export class WorkspaceService {
  constructor(private readonly runner: ProcessRunner) {}

  async prepare(input: {
    repository: string
    issueNumber: number
    runId: string
    baseBranch: string
    workspaceRoot: string
    token?: string
  }): Promise<PreparedWorkspace> {
    const root = join(input.workspaceRoot, input.runId)
    const source = join(root, "source")
    const worktree = join(root, "worktree")
    const branch = branchForIssue(input.issueNumber)
    mkdirSync(root, { recursive: true })
    const clone = [
      "git", "-c", "core.hooksPath=/dev/null", "-c", "credential.helper=", "-c",
      `credential.helper=${credentialHelper}`, "clone", "--no-checkout",
      `https://github.com/${input.repository}.git`, source,
    ]
    await requireSuccess(this.runner, clone, {
      cleanEnv: true,
      env: { ...gitEnvironment(), GH_TOKEN: input.token },
    })
    await requireSuccess(this.runner, [
      "git", "-c", "core.hooksPath=/dev/null", "-C", source,
      "worktree", "add", worktree, "-b", branch, `origin/${input.baseBranch}`,
    ], { cleanEnv: true, env: gitEnvironment() })
    const head = await requireSuccess(this.runner, ["git", "rev-parse", "HEAD"], {
      cwd: worktree,
      cleanEnv: true,
      env: gitEnvironment(),
    })
    return { root, source, worktree, branch, baseHead: head.stdout.trim() }
  }

  async openExisting(input: {
    issueNumber: number
    runId: string
    workspaceRoot: string
  }): Promise<PreparedWorkspace> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.runId)) throw new Error("Invalid workflow run ID")
    const root = join(input.workspaceRoot, input.runId)
    const source = join(root, "source")
    const worktree = join(root, "worktree")
    const branch = branchForIssue(input.issueNumber)
    const localGit = { cwd: worktree, cleanEnv: true, env: gitEnvironment() }
    const currentBranch = await requireSuccess(this.runner, ["git", "branch", "--show-current"], localGit)
    if (currentBranch.stdout.trim() !== branch) throw new Error("Existing worktree is on an unexpected branch")
    const head = await requireSuccess(this.runner, ["git", "rev-parse", "HEAD"], localGit)
    return { root, source, worktree, branch, baseHead: head.stdout.trim() }
  }

  async createAttestation(input: {
    issueNumber: number
    runId: string
    workspaceRoot: string
    expectedPatchSha256: string
  }): Promise<WorkspaceAttestation> {
    const workspace = await this.openExisting(input)
    const changedFiles = await this.changedFiles(workspace.worktree, workspace.baseHead)
    if (!changedFiles.length) throw new Error("Validated worktree contains no changes")
    const patch = await this.createPatch(workspace.worktree, changedFiles)
    const patchSha256 = createHash("sha256").update(patch).digest("hex")
    if (!/^[0-9a-f]{64}$/.test(input.expectedPatchSha256) || patchSha256 !== input.expectedPatchSha256) {
      throw new Error("Validated patch digest does not match the current worktree")
    }
    return {
      version: 1,
      runId: input.runId,
      issueNumber: input.issueNumber,
      branch: workspace.branch,
      baseHead: workspace.baseHead,
      changedFiles,
      patchSha256,
    }
  }

  async verifyAttestation(input: {
    issueNumber: number
    runId: string
    workspaceRoot: string
  }): Promise<{ workspace: PreparedWorkspace; changedFiles: string[] }> {
    const workspace = await this.openExisting(input)
    const path = join(workspace.root, "validation.json")
    let attestation: WorkspaceAttestation
    try {
      attestation = JSON.parse(readFileSync(path, "utf8")) as WorkspaceAttestation
    } catch {
      throw new Error("Validated workspace attestation is missing or invalid")
    }
    if (
      attestation.version !== 1
      || attestation.runId !== input.runId
      || attestation.issueNumber !== input.issueNumber
      || attestation.branch !== workspace.branch
      || !/^[0-9a-f]{40}$/.test(attestation.baseHead)
      || !/^[0-9a-f]{64}$/.test(attestation.patchSha256)
      || !Array.isArray(attestation.changedFiles)
      || !attestation.changedFiles.length
      || attestation.changedFiles.some((file) => typeof file !== "string")
    ) {
      throw new Error("Validated workspace attestation does not match this run")
    }

    const localGit = { cwd: workspace.worktree, cleanEnv: true, env: gitEnvironment() }
    await requireSuccess(this.runner, ["git", "reset", "--mixed", "HEAD", "--"], localGit)

    let changedFiles: string[]
    let patch: string
    if (workspace.baseHead === attestation.baseHead) {
      changedFiles = await this.changedFiles(workspace.worktree, attestation.baseHead)
      patch = await this.createPatch(workspace.worktree, changedFiles)
    } else {
      const parent = await requireSuccess(this.runner, ["git", "rev-parse", "HEAD^"], localGit)
      if (parent.stdout.trim() !== attestation.baseHead) throw new Error("Published worktree diverged from validation")
      const pending = await this.changedFiles(workspace.worktree, workspace.baseHead)
      if (pending.length) throw new Error("Published worktree changed after its commit")
      const files = await requireSuccess(
        this.runner,
        ["git", "diff", "--name-only", "-z", attestation.baseHead, workspace.baseHead],
        localGit,
      )
      changedFiles = files.stdout.split("\0").filter(Boolean).sort()
      const committedPatch = await requireSuccess(
        this.runner,
        ["git", "diff", "--binary", attestation.baseHead, workspace.baseHead, "--", ...changedFiles],
        localGit,
      )
      patch = committedPatch.stdout
    }
    if (JSON.stringify(changedFiles) !== JSON.stringify([...attestation.changedFiles].sort())) {
      throw new Error("Published change set differs from validation")
    }
    if (createHash("sha256").update(patch).digest("hex") !== attestation.patchSha256) {
      throw new Error("Published patch differs from validation")
    }
    return {
      workspace: { ...workspace, baseHead: attestation.baseHead },
      changedFiles,
    }
  }

  async changedFiles(worktree: string, baseHead?: string): Promise<string[]> {
    if (baseHead) await this.assertHead(worktree, baseHead)
    const localGit = { cwd: worktree, cleanEnv: true, env: gitEnvironment() }
    const staged = await requireSuccess(this.runner, ["git", "diff", "--cached", "--name-only", "-z"], localGit)
    if (staged.stdout) throw new Error("OpenCode left pre-staged files in the worktree")
    const tracked = await requireSuccess(this.runner, ["git", "diff", "--name-only", "-z"], localGit)
    const untracked = await requireSuccess(this.runner, ["git", "ls-files", "--others", "--exclude-standard", "-z"], localGit)
    return [...new Set(`${tracked.stdout}${untracked.stdout}`.split("\0").filter(Boolean))].sort()
  }

  async validate(worktree: string, commands: string[]): Promise<void> {
    const home = join(dirname(worktree), "validation-home")
    mkdirSync(home, { recursive: true })
    for (const command of commands) {
      await requireSuccess(this.runner, ["bash", "-c", command], {
        cwd: worktree,
        cleanEnv: true,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          CI: "true",
          ...scrubGitHubEnvironment(),
        },
      })
    }
  }

  async createPatch(worktree: string, changedFiles: string[]): Promise<string> {
    if (!changedFiles.length) throw new Error("No changed files to export")
    this.assertSafePaths(changedFiles, "export")
    const localGit = { cwd: worktree, cleanEnv: true, env: gitEnvironment() }
    await requireSuccess(this.runner, ["git", "add", "--intent-to-add", "--", ...changedFiles], localGit)
    try {
      const patch = await requireSuccess(
        this.runner,
        ["git", "diff", "--binary", "HEAD", "--", ...changedFiles],
        localGit,
      )
      if (Buffer.byteLength(patch.stdout) > 10 * 1024 * 1024) throw new Error("Refusing to export a patch larger than 10 MiB")
      return patch.stdout
    } finally {
      await requireSuccess(this.runner, ["git", "reset", "--mixed", "HEAD", "--"], localGit)
    }
  }

  async commitAndPush(input: {
    repository: string
    worktree: string
    branch: string
    issue: Issue
    changedFiles: string[]
    token: string
    baseHead?: string
  }): Promise<void> {
    this.assertSafePaths(input.changedFiles, "publish")
    if (!input.changedFiles.length) throw new Error("No changed files to publish")
    const localGit = { cwd: input.worktree, cleanEnv: true, env: gitEnvironment() }
    const remoteUrl = await requireSuccess(this.runner, ["git", "remote", "get-url", "origin"], localGit)
    const pushUrl = await requireSuccess(this.runner, ["git", "remote", "get-url", "--push", "origin"], localGit)
    const expectedRemote = `https://github.com/${input.repository}.git`
    if (remoteUrl.stdout.trim() !== expectedRemote || pushUrl.stdout.trim() !== expectedRemote) {
      throw new Error("Worktree origin does not match the requested repository")
    }

    const head = await requireSuccess(this.runner, ["git", "rev-parse", "HEAD"], localGit)
    let alreadyCommitted = false
    if (input.baseHead && head.stdout.trim() !== input.baseHead) {
      const parent = await requireSuccess(this.runner, ["git", "rev-parse", "HEAD^"], localGit)
      if (parent.stdout.trim() !== input.baseHead) throw new Error("Worktree HEAD changed after validation")
      const pending = await this.changedFiles(input.worktree, head.stdout.trim())
      if (pending.length) throw new Error("Worktree changed after the publication commit")
      alreadyCommitted = true
    }
    if (!alreadyCommitted) {
      if (input.baseHead) await this.assertHead(input.worktree, input.baseHead)
      await requireSuccess(this.runner, ["git", "reset", "--mixed", "HEAD", "--"], localGit)
      await requireSuccess(this.runner, ["git", "add", "--", ...input.changedFiles], localGit)
      const staged = await requireSuccess(this.runner, ["git", "diff", "--cached", "--name-only", "-z"], localGit)
      const stagedFiles = staged.stdout.split("\0").filter(Boolean).sort()
      if (JSON.stringify(stagedFiles) !== JSON.stringify([...input.changedFiles].sort())) {
        throw new Error("Staged files do not match the reviewed change set")
      }
      await requireSuccess(this.runner, [
        "git", "-c", "core.hooksPath=/dev/null", "-c", "user.name=prokube coding bot", "-c", "user.email=bot@prokube.ai",
        "commit", "-m", `Implement issue #${input.issue.number}`,
      ], localGit)
    }

    const localHead = await requireSuccess(this.runner, ["git", "rev-parse", "HEAD"], localGit)
    const authenticatedGit = {
      cwd: input.worktree,
      cleanEnv: true,
      env: { ...gitEnvironment(), GH_TOKEN: input.token },
    }
    const remote = await requireSuccess(this.runner, [
      "git", "-c", "credential.helper=", "-c", `credential.helper=${credentialHelper}`,
      "ls-remote", "--heads", "origin", input.branch,
    ], authenticatedGit)
    if (remote.stdout.trim()) {
      const remoteHead = remote.stdout.trim().split(/\s+/)[0]
      if (remoteHead !== localHead.stdout.trim()) throw new Error(`Remote branch already exists: ${input.branch}`)
      return
    }
    await requireSuccess(this.runner, [
      "git", "-c", "core.hooksPath=/dev/null", "-c", "credential.helper=", "-c",
      `credential.helper=${credentialHelper}`,
      "push", "-u", "origin", input.branch,
    ], authenticatedGit)
  }

  async assertRemoteBranchAbsent(input: {
    repository: string
    worktree: string
    branch: string
    token: string
    baseHead: string
  }): Promise<void> {
    const localGit = { cwd: input.worktree, cleanEnv: true, env: gitEnvironment() }
    const expectedRemote = `https://github.com/${input.repository}.git`
    const remoteUrl = await requireSuccess(this.runner, ["git", "remote", "get-url", "origin"], localGit)
    const pushUrl = await requireSuccess(this.runner, ["git", "remote", "get-url", "--push", "origin"], localGit)
    if (remoteUrl.stdout.trim() !== expectedRemote || pushUrl.stdout.trim() !== expectedRemote) {
      throw new Error("Worktree origin does not match the requested repository")
    }
    const remote = await requireSuccess(this.runner, [
      "git", "-c", "credential.helper=", "-c", `credential.helper=${credentialHelper}`,
      "ls-remote", "--heads", "origin", input.branch,
    ], {
      cwd: input.worktree,
      cleanEnv: true,
      env: { ...gitEnvironment(), GH_TOKEN: input.token },
    })
    if (remote.stdout.trim()) {
      const localHead = await requireSuccess(this.runner, ["git", "rev-parse", "HEAD"], localGit)
      const remoteHead = remote.stdout.trim().split(/\s+/)[0]
      if (localHead.stdout.trim() === input.baseHead || remoteHead !== localHead.stdout.trim()) {
        throw new Error(`Remote branch already exists: ${input.branch}`)
      }
    }
  }

  private async assertHead(worktree: string, expected: string): Promise<void> {
    const head = await requireSuccess(this.runner, ["git", "rev-parse", "HEAD"], {
      cwd: worktree,
      cleanEnv: true,
      env: gitEnvironment(),
    })
    if (head.stdout.trim() !== expected) throw new Error("Worktree HEAD changed during agent execution")
  }

  private assertSafePaths(changedFiles: string[], action: "export" | "publish"): void {
    const unsafe = changedFiles.filter((file) => sensitivePath.test(file))
    if (unsafe.length) throw new Error(`Refusing to ${action} sensitive paths: ${unsafe.join(", ")}`)
  }
}

export function scrubGitHubEnvironment(): Record<string, undefined> {
  return {
    GH_TOKEN: undefined,
    GITHUB_TOKEN: undefined,
    GITHUB_PAT: undefined,
  }
}

function gitEnvironment(): Record<string, string | undefined> {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    ...scrubGitHubEnvironment(),
  }
}
