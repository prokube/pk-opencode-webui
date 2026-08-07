import { branchForIssue, evaluateWorkflowOwnership, runPhases, type Issue, type RunPhase } from "./domain"
import { parseClaimRecord, type WorkflowClaimRecord } from "./claim-record"
import { GitHubClient } from "./github"

type CleanupResult = {
  runId?: string
  phase?: RunPhase
  pullRequestUrl?: string
}

export interface ClaimCleanupService {
  getAuthenticatedLogin(): Promise<string>
  getIssue(repository: string, issueNumber: number): Promise<Issue>
  findPullRequest(
    repository: string,
    branch: string,
    issueNumber: number,
    state: "all",
  ): Promise<string | undefined>
  releaseIssueClaim(
    repository: string,
    issueNumber: number,
    botLogin: string,
    runId: string,
    reason: string,
  ): Promise<boolean>
}

export async function reconcileWorkflowClaim(input: {
  record?: WorkflowClaimRecord
  expectedRunId: string
  workflowStatus: string
  result?: CleanupResult
  github: ClaimCleanupService
}): Promise<{ action: "noop" | "released"; reason: string }> {
  if (!input.record) return { action: "noop", reason: "No durable workflow claim record" }
  if (input.record.runId !== input.expectedRunId) {
    return { action: "noop", reason: "Workflow claim record belongs to another run" }
  }
  const login = await input.github.getAuthenticatedLogin()
  if (login !== input.record.botLogin) {
    return { action: "noop", reason: "Authenticated GitHub user does not own the workflow claim" }
  }
  const issue = await input.github.getIssue(input.record.project, input.record.number)
  const ownership = evaluateWorkflowOwnership(issue, login, input.record.runId)
  if (!ownership.eligible) return { action: "noop", reason: ownership.reason }
  if (input.result?.runId === input.record.runId && input.result.phase === "completed"
    && isPullRequestUrl(input.result.pullRequestUrl, input.record.project)) {
    return { action: "noop", reason: "Workflow result contains a completed pull request" }
  }
  const pullRequest = await input.github.findPullRequest(
    input.record.project,
    branchForIssue(input.record.number),
    input.record.number,
    "all",
  )
  if (pullRequest) return { action: "noop", reason: "A pull request already exists" }
  const phase = input.result?.runId === input.record.runId && input.result.phase
    ? input.result.phase
    : "unknown"
  const reason = `workflow status ${safeStatus(input.workflowStatus)}, result phase ${phase}`
  const released = await input.github.releaseIssueClaim(
    input.record.project,
    input.record.number,
    login,
    input.record.runId,
    reason,
  )
  return released
    ? { action: "released", reason }
    : { action: "noop", reason: "Claimed issue is no longer open" }
}

export async function cleanupMain(): Promise<number> {
  const claimPath = process.env.PK_WORKFLOW_CLAIM_FILE ?? "/workspace/.workflow-claim.json"
  const claimFile = Bun.file(claimPath)
  if (!await claimFile.exists()) {
    console.log(JSON.stringify({ action: "noop", reason: "No durable workflow claim record" }))
    return 0
  }
  if (claimFile.size > 4096) throw new Error("Workflow claim record is oversized")
  const record = parseClaimRecord(await claimFile.text())
  const expectedRunId = process.env.PK_WORKFLOW_RUN_ID
  if (!expectedRunId) throw new Error("PK_WORKFLOW_RUN_ID is required for claim cleanup")
  const result = await readResult(process.env.PK_WORKFLOW_RESULT_FILE ?? "/workspace/.workflow-output/result.json")
  const outcome = await reconcileWorkflowClaim({
    record,
    expectedRunId,
    workflowStatus: process.env.PK_WORKFLOW_STATUS ?? "Unknown",
    result,
    github: new GitHubClient(process.env.GH_TOKEN),
  })
  console.log(JSON.stringify(outcome))
  return 0
}

async function readResult(path: string): Promise<CleanupResult | undefined> {
  const file = Bun.file(path)
  if (!await file.exists() || file.size > 64 * 1024) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(await file.text())
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined
  const value = parsed as Record<string, unknown>
  return {
    runId: typeof value.runId === "string" ? value.runId : undefined,
    phase: typeof value.phase === "string" && runPhases.includes(value.phase as RunPhase)
      ? value.phase as RunPhase
      : undefined,
    pullRequestUrl: typeof value.pullRequestUrl === "string" ? value.pullRequestUrl : undefined,
  }
}

function isPullRequestUrl(value: string | undefined, repository: string): boolean {
  return Boolean(value && new RegExp(`^https://github\\.com/${escapeRegex(repository)}/pull/[1-9][0-9]*$`).test(value))
}

function safeStatus(value: string): string {
  return ["Succeeded", "Failed", "Error"].includes(value) ? value : "Unknown"
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

if (import.meta.main) {
  cleanupMain().then((code) => process.exit(code)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
