import type { GitHubService } from "./github"
import type { OpenCodeService } from "./opencode"
import type { WorkspaceService } from "./workspace"
import {
  evaluateEligibility,
  validateRepository,
  type RunPhase,
  type WorkflowRequest,
  type WorkflowResult,
} from "./domain"

export class CodingWorkflow {
  constructor(
    private readonly github: GitHubService,
    private readonly workspaces: WorkspaceService,
    private readonly opencode: OpenCodeService,
    private readonly token?: string,
    private readonly createRunId: () => string = () => crypto.randomUUID(),
  ) {}

  async run(request: WorkflowRequest): Promise<WorkflowResult> {
    const repository = validateRepository(request.repository)
    const runId = this.createRunId()
    const result = (phase: RunPhase, summary: string, extra: Partial<WorkflowResult> = {}): WorkflowResult => {
      return { runId, phase, summary, ...extra }
    }

    try {
      const issue = await this.github.getIssue(repository, request.issueNumber)

      if (request.mode === "finalize") {
        if (!this.token) throw new Error("GH_TOKEN is required in finalize mode")
        const branch = `feature/issue-${issue.number}`
        const duplicate = await this.github.findOpenPullRequest(repository, branch, issue.number)
        if (duplicate) return result("completed", `Pull request already exists: ${duplicate}`, {
          branch,
          pullRequestUrl: duplicate,
        })
        const botLogin = await this.github.getAuthenticatedLogin()
        const claimMarker = `Coding workflow \`${runId}\` claimed this issue.`
        const claimedByThisRun = issue.comments.some(
          (comment) => comment.author === botLogin && comment.body.includes(claimMarker),
        )
        const eligibility = evaluateEligibility(issue)
        if (!eligibility.eligible && !claimedByThisRun) return result("blocked", eligibility.reason)
        const verified = await this.workspaces.verifyAttestation({
          issueNumber: issue.number,
          runId,
          workspaceRoot: request.workspaceRoot,
        })
        const { workspace, changedFiles } = verified
        await this.workspaces.assertRemoteBranchAbsent({
          repository,
          worktree: workspace.worktree,
          branch: workspace.branch,
          token: this.token,
          baseHead: workspace.baseHead,
        })
        await this.github.claimIssue(repository, issue, botLogin, runId)
        await this.workspaces.commitAndPush({
          repository,
          worktree: workspace.worktree,
          branch: workspace.branch,
          issue,
          changedFiles,
          token: this.token,
          baseHead: workspace.baseHead,
        })
        const concurrent = await this.github.findOpenPullRequest(repository, workspace.branch, issue.number)
        if (concurrent) return result("blocked", `An open pull request already exists: ${concurrent}`, {
          branch: workspace.branch,
          workspace: workspace.worktree,
          pullRequestUrl: concurrent,
          changedFiles,
        })
        const pullRequestUrl = await this.github.createPullRequest({
          repository,
          issue,
          branch: workspace.branch,
          baseBranch: request.baseBranch,
          changedFiles,
        })
        return result("completed", "Validated pull request created", {
          branch: workspace.branch,
          workspace: workspace.worktree,
          pullRequestUrl,
          changedFiles,
        })
      }

      const eligibility = evaluateEligibility(issue)
      if (!eligibility.eligible) return result("blocked", eligibility.reason)

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
        await this.github.claimIssue(repository, issue, request.botLogin, runId)
      }

      const workspace = await this.workspaces.prepare({
        repository,
        issueNumber: issue.number,
        runId,
        baseBranch: request.baseBranch,
        workspaceRoot: request.workspaceRoot,
        token: this.token,
      })
      const implementationInput = {
        issue,
        repository,
        worktree: workspace.worktree,
        validationCommands: request.validationCommands,
      }
      const implementation = await this.opencode.implement(implementationInput)
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

      let sessionId = implementation.sessionId
      let changedFiles = await this.workspaces.changedFiles(workspace.worktree, workspace.baseHead)
      if (!changedFiles.length) {
        return result("blocked", "OpenCode completed without changing files", {
          branch: workspace.branch,
          workspace: workspace.worktree,
          sessionId: implementation.sessionId,
          changedFiles,
        })
      }

      if (request.mode === "implement") {
        return result("validating", "Implementation completed pending deterministic validation", {
          branch: workspace.branch,
          workspace: workspace.worktree,
          sessionId,
          changedFiles,
        })
      }

      try {
        await this.workspaces.validate(workspace.worktree, request.validationCommands)
      } catch (error) {
        const validationFeedback = error instanceof Error ? error.message : String(error)
        const remediation = await this.opencode.implement({ ...implementationInput, validationFeedback })
        if (remediation.status === "blocked") {
          return result("blocked", remediation.question ?? "OpenCode requested guidance during remediation", {
            branch: workspace.branch,
            workspace: workspace.worktree,
            sessionId: remediation.sessionId,
            changedFiles,
          })
        }
        sessionId = remediation.sessionId
        changedFiles = await this.workspaces.changedFiles(workspace.worktree, workspace.baseHead)
        await this.workspaces.validate(workspace.worktree, request.validationCommands)
      }
      changedFiles = await this.workspaces.changedFiles(workspace.worktree, workspace.baseHead)
      if (!changedFiles.length) {
        return result("blocked", "Validation or remediation removed all implementation changes", {
          branch: workspace.branch,
          workspace: workspace.worktree,
          sessionId,
          changedFiles,
        })
      }

      if (request.mode === "execute") {
        return result("completed", "Implementation and validation completed without publishing", {
          branch: workspace.branch,
          workspace: workspace.worktree,
          sessionId,
          changedFiles,
        })
      }

      await this.workspaces.commitAndPush({
        repository,
        worktree: workspace.worktree,
        branch: workspace.branch,
        issue,
        changedFiles,
        token: this.token!,
        baseHead: workspace.baseHead,
      })
      const existing = await this.github.findOpenPullRequest(repository, workspace.branch, issue.number)
      if (existing) return result("blocked", `An open pull request already exists: ${existing}`, {
        branch: workspace.branch,
        workspace: workspace.worktree,
        sessionId,
        pullRequestUrl: existing,
        changedFiles,
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
        sessionId,
        pullRequestUrl,
        changedFiles,
      })
    } catch (error) {
      return result("failed", error instanceof Error ? error.message : String(error))
    }
  }
}
