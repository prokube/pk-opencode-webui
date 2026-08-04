import { mkdirSync } from "node:fs"
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
      "git", "-c", `credential.helper=${credentialHelper}`, "clone", "--no-checkout",
      `https://github.com/${input.repository}.git`, source,
    ]
    await requireSuccess(this.runner, clone, { env: { GH_TOKEN: input.token } })
    await requireSuccess(this.runner, [
      "git", "-C", source, "worktree", "add", worktree, "-b", branch, `origin/${input.baseBranch}`,
    ])
    const head = await requireSuccess(this.runner, ["git", "rev-parse", "HEAD"], { cwd: worktree })
    return { root, source, worktree, branch, baseHead: head.stdout.trim() }
  }

  async changedFiles(worktree: string, baseHead?: string): Promise<string[]> {
    if (baseHead) await this.assertHead(worktree, baseHead)
    const staged = await requireSuccess(this.runner, ["git", "diff", "--cached", "--name-only", "-z"], { cwd: worktree })
    if (staged.stdout) throw new Error("OpenCode left pre-staged files in the worktree")
    const tracked = await requireSuccess(this.runner, ["git", "diff", "--name-only", "-z"], { cwd: worktree })
    const untracked = await requireSuccess(this.runner, ["git", "ls-files", "--others", "--exclude-standard", "-z"], { cwd: worktree })
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

  async commitAndPush(input: {
    worktree: string
    branch: string
    issue: Issue
    changedFiles: string[]
    token: string
    baseHead?: string
  }): Promise<void> {
    if (input.baseHead) await this.assertHead(input.worktree, input.baseHead)
    const unsafe = input.changedFiles.filter((file) => sensitivePath.test(file))
    if (unsafe.length) throw new Error(`Refusing to publish sensitive paths: ${unsafe.join(", ")}`)
    if (!input.changedFiles.length) throw new Error("No changed files to publish")
    await requireSuccess(this.runner, ["git", "reset", "--mixed", "HEAD", "--"], { cwd: input.worktree })
    await requireSuccess(this.runner, ["git", "add", "--", ...input.changedFiles], { cwd: input.worktree })
    const staged = await requireSuccess(this.runner, ["git", "diff", "--cached", "--name-only", "-z"], {
      cwd: input.worktree,
    })
    const stagedFiles = staged.stdout.split("\0").filter(Boolean).sort()
    if (JSON.stringify(stagedFiles) !== JSON.stringify([...input.changedFiles].sort())) {
      throw new Error("Staged files do not match the reviewed change set")
    }
    const remote = await requireSuccess(this.runner, [
      "git", "-c", `credential.helper=${credentialHelper}`, "ls-remote", "--heads", "origin", input.branch,
    ], { cwd: input.worktree, env: { GH_TOKEN: input.token } })
    if (remote.stdout.trim()) throw new Error(`Remote branch already exists: ${input.branch}`)
    await requireSuccess(this.runner, [
      "git", "-c", "user.name=prokube coding bot", "-c", "user.email=bot@prokube.ai",
      "commit", "-m", `Implement issue #${input.issue.number}`,
    ], { cwd: input.worktree })
    await requireSuccess(this.runner, [
      "git", "-c", `credential.helper=${credentialHelper}`, "push", "-u", "origin", input.branch,
    ], { cwd: input.worktree, env: { GH_TOKEN: input.token } })
  }

  private async assertHead(worktree: string, expected: string): Promise<void> {
    const head = await requireSuccess(this.runner, ["git", "rev-parse", "HEAD"], { cwd: worktree })
    if (head.stdout.trim() !== expected) throw new Error("Worktree HEAD changed during agent execution")
  }
}

export function scrubGitHubEnvironment(): Record<string, undefined> {
  return {
    GH_TOKEN: undefined,
    GITHUB_TOKEN: undefined,
    GITHUB_PAT: undefined,
  }
}
