import type { GitHubService } from "./github"
import type { OpenCodeService } from "./opencode"
import type { RunStore } from "./store"
import type { WorkspaceService } from "./workspace"
import {
  evaluateEligibility,
  issueRunKey,
  validateRepository,
  type RunPhase,
  type WorkflowRequest,
  type WorkflowResult,
} from "./domain"

export class CodingWorkflow {
  constructor(
    private readonly store: RunStore,
    private readonly github: GitHubService,
    private readonly workspaces: WorkspaceService,
    private readonly opencode: OpenCodeService,
    private readonly token?: string,
  ) {}

  async run(request: WorkflowRequest): Promise<WorkflowResult> {
    const repository = validateRepository(request.repository)
    const record = this.store.createRun({
      runKey: issueRunKey(repository, request.issueNumber),
      repository,
      issueNumber: request.issueNumber,
      mode: request.mode,
    })
    const heartbeat = setInterval(() => this.store.heartbeat(record.runId), 60_000)
    heartbeat.unref()
    const result = (phase: RunPhase, summary: string, extra: Partial<WorkflowResult> = {}): WorkflowResult => {
      const next = { runId: record.runId, phase, summary, ...extra }
      this.store.updateRun(record.runId, next)
      return next
    }

    try {
      const issue = await this.github.getIssue(repository, request.issueNumber)
      const eligibility = evaluateEligibility(issue)
      if (!eligibility.eligible) return result("blocked", eligibility.reason)
      result("eligible", "Issue is eligible for implementation")

      if (request.mode === "plan") {
        return result("completed", `Plan validated for ${repository}#${issue.number}`)
      }

      if (request.mode === "publish") {
        if (!this.token) throw new Error("GH_TOKEN is required in publish mode")
        if (!request.botLogin) throw new Error("--bot-login is required in publish mode")
        const existing = await this.github.findOpenPullRequest(repository, `feature/issue-${issue.number}`, issue.number)
        if (existing) return result("blocked", `An open pull request already exists: ${existing}`, {
          pullRequestUrl: existing,
        })
        await this.github.claimIssue(repository, issue, request.botLogin, record.runId)
        result("claimed", `Claimed ${repository}#${issue.number}`)
      }

      const workspace = await this.workspaces.prepare({
        repository,
        issueNumber: issue.number,
        runId: record.runId,
        baseBranch: request.baseBranch,
        workspaceRoot: request.workspaceRoot,
        token: this.token,
      })
      result("prepared", "Prepared isolated Git worktree", {
        branch: workspace.branch,
        workspace: workspace.worktree,
      })

      result("implementing", "OpenCode is implementing the issue", {
        branch: workspace.branch,
        workspace: workspace.worktree,
      })
      const implementation = await this.opencode.implement({
        issue,
        repository,
        worktree: workspace.worktree,
        validationCommands: request.validationCommands,
      })
      if (implementation.status === "blocked") {
        if (request.mode === "publish") {
          await this.github.comment(repository, issue.number, `Workflow blocked: ${implementation.question}`)
        }
        return result("blocked", implementation.question ?? "OpenCode requested guidance", {
          branch: workspace.branch,
          workspace: workspace.worktree,
          sessionId: implementation.sessionId,
        })
      }

      const changedFiles = await this.workspaces.changedFiles(workspace.worktree, workspace.baseHead)
      if (!changedFiles.length) {
        return result("blocked", "OpenCode completed without changing files", {
          branch: workspace.branch,
          workspace: workspace.worktree,
          sessionId: implementation.sessionId,
          changedFiles,
        })
      }

      result("validating", "Running deterministic validation", {
        branch: workspace.branch,
        workspace: workspace.worktree,
        sessionId: implementation.sessionId,
        changedFiles,
      })
      await this.workspaces.validate(workspace.worktree, request.validationCommands)

      if (request.mode === "execute") {
        return result("completed", "Implementation and validation completed without publishing", {
          branch: workspace.branch,
          workspace: workspace.worktree,
          sessionId: implementation.sessionId,
          changedFiles,
        })
      }

      result("publishing", "Publishing branch and pull request", {
        branch: workspace.branch,
        workspace: workspace.worktree,
        sessionId: implementation.sessionId,
        changedFiles,
      })
      await this.workspaces.commitAndPush({
        worktree: workspace.worktree,
        branch: workspace.branch,
        issue,
        changedFiles,
        token: this.token!,
        baseHead: workspace.baseHead,
      })
      const pullRequestUrl = await this.github.createPullRequest({
        repository,
        issue,
        branch: workspace.branch,
        baseBranch: request.baseBranch,
        changedFiles,
      })
      return result("completed", "Pull request created", {
        branch: workspace.branch,
        workspace: workspace.worktree,
        sessionId: implementation.sessionId,
        pullRequestUrl,
        changedFiles,
      })
    } catch (error) {
      return result("failed", error instanceof Error ? error.message : String(error))
    } finally {
      clearInterval(heartbeat)
      this.store.release(record.runId)
    }
  }
}
