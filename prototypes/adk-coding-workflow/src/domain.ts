export const runModes = ["plan", "execute", "publish"] as const
export type RunMode = (typeof runModes)[number]

export const runPhases = [
  "created",
  "eligible",
  "claimed",
  "prepared",
  "implementing",
  "validating",
  "publishing",
  "completed",
  "blocked",
  "failed",
] as const
export type RunPhase = (typeof runPhases)[number]

export type Issue = {
  number: number
  title: string
  body: string
  state: string
  labels: string[]
  assignees: string[]
  comments: Array<{ author: string; body: string }>
  openBlockers: Array<{ number: number; title: string }>
  url: string
}

export type WorkflowRequest = {
  repository: string
  issueNumber: number
  mode: RunMode
  baseBranch: string
  workspaceRoot: string
  validationCommands: string[]
  botLogin?: string
}

export type WorkflowResult = {
  runId: string
  phase: RunPhase
  summary: string
  branch?: string
  workspace?: string
  sessionId?: string
  pullRequestUrl?: string
  changedFiles?: string[]
}

export type RunRecord = WorkflowResult & {
  repository: string
  issueNumber: number
  mode: RunMode
  createdAt: string
  updatedAt: string
}

export type Eligibility =
  | { eligible: true }
  | { eligible: false; reason: string }

export function evaluateEligibility(issue: Issue): Eligibility {
  if (issue.state !== "open") return { eligible: false, reason: "Issue is not open" }
  if (!issue.labels.includes("ready")) return { eligible: false, reason: "Issue is not labeled ready" }
  if (issue.labels.includes("in-progress")) return { eligible: false, reason: "Issue is already in progress" }
  if (issue.labels.includes("needs-discussion")) return { eligible: false, reason: "Issue needs discussion" }
  if (issue.assignees.length) return { eligible: false, reason: "Issue already has an assignee" }
  if (issue.openBlockers.length) {
    const blockers = issue.openBlockers.map((blocker) => `#${blocker.number}`).join(", ")
    return { eligible: false, reason: `Issue is blocked by ${blockers}` }
  }
  return { eligible: true }
}

export function validateRepository(value: string): string {
  const repository = value.trim()
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error(`Invalid GitHub repository: ${value}`)
  }
  return repository
}

export function branchForIssue(issueNumber: number): string {
  return `feature/issue-${issueNumber}`
}

export function issueRunKey(repository: string, issueNumber: number): string {
  return `${validateRepository(repository)}#${issueNumber}`
}

export function reviewRunKey(repository: string, pullRequest: number, cycle: number): string {
  return `${validateRepository(repository)}!${pullRequest}/remediation-${cycle}`
}
