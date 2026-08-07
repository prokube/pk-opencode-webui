export const runModes = ["plan", "implement", "execute", "attest", "finalize", "publish"] as const
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

export type Eligibility =
  | { eligible: true }
  | { eligible: false; reason: string }

export const ticketPriorities = ["critical", "high", "medium", "low"] as const
export type TicketPriority = (typeof ticketPriorities)[number]

export type DiscoveryProject = {
  provider: string
  project: string
  suggestedBaseBranch: string
}

export type TicketLabelPolicy = {
  includeLabels: string[]
  excludeLabels: string[]
}

export type DiscoveryRequest = {
  projects: DiscoveryProject[]
  labelPolicy: TicketLabelPolicy
}

export type TicketCandidate = {
  provider: string
  project: string
  number: number
  title: string
  author: string
  priority: TicketPriority
  url: string
  suggestedBaseBranch: string
}

export type CandidateList = {
  candidates: TicketCandidate[]
  truncated: boolean
}

export type SelectedTicket = {
  provider: string
  project: string
  number: number
}

export type ValidatedSelection = SelectedTicket & {
  baseBranch: string
}

export function evaluateEligibility(issue: Issue): Eligibility {
  if (issue.state !== "open") return { eligible: false, reason: "Issue is not open" }
  if (!issue.labels.includes("ready")) return { eligible: false, reason: "Issue is not labeled ready" }
  if (issue.labels.includes("in-progress")) return { eligible: false, reason: "Issue is already in progress" }
  if (issue.labels.includes("needs-discussion")) return { eligible: false, reason: "Issue needs discussion" }
  if (issue.labels.includes("needs-supervisor")) return { eligible: false, reason: "Issue needs supervisor attention" }
  if (issue.assignees.length) return { eligible: false, reason: "Issue already has an assignee" }
  if (issue.openBlockers.length) {
    const blockers = issue.openBlockers.map((blocker) => `#${blocker.number}`).join(", ")
    return { eligible: false, reason: `Issue is blocked by ${blockers}` }
  }
  return { eligible: true }
}

export function evaluateTicketEligibility(issue: Issue, policy: TicketLabelPolicy): Eligibility {
  if (issue.state !== "open") return { eligible: false, reason: "Issue is not open" }
  const labels = new Set(issue.labels.map((label) => label.toLowerCase()))
  const missing = policy.includeLabels.find((label) => !labels.has(label.toLowerCase()))
  if (missing) return { eligible: false, reason: `Issue is missing required label: ${missing}` }
  const excluded = policy.excludeLabels.find((label) => labels.has(label.toLowerCase()))
  if (excluded) return { eligible: false, reason: `Issue has excluded label: ${excluded}` }
  if (issue.assignees.length) return { eligible: false, reason: "Issue already has an assignee" }
  if (issue.openBlockers.length) {
    const blockers = issue.openBlockers.map((blocker) => `#${blocker.number}`).join(", ")
    return { eligible: false, reason: `Issue is blocked by ${blockers}` }
  }
  return { eligible: true }
}

export function workflowClaimComment(runId: string): string {
  return `Coding workflow \`${runId}\` claimed this issue.`
}

export function isClaimedByWorkflow(issue: Issue, botLogin: string, runId: string): boolean {
  const marker = workflowClaimComment(runId)
  return issue.comments.some((comment) => comment.author === botLogin && comment.body.trim() === marker)
}

export function hasWorkflowClaim(issue: Issue): boolean {
  return issue.comments.some((comment) => /^Coding workflow `[^`]+` claimed this issue\.$/.test(comment.body.trim()))
}

export function evaluateWorkflowOwnership(issue: Issue, botLogin: string, runId: string): Eligibility {
  const marker = workflowClaimComment(runId)
  const claimComments = issue.comments.filter((comment) => /^Coding workflow `[^`]+` claimed this issue\.$/.test(comment.body.trim()))
  if (claimComments.some((comment) => comment.author !== botLogin || comment.body.trim() !== marker)) {
    return { eligible: false, reason: "Issue has a conflicting workflow claim" }
  }
  if (!isClaimedByWorkflow(issue, botLogin, runId)) {
    return { eligible: false, reason: "Issue is not claimed by this workflow" }
  }
  if (issue.assignees.some((assignee) => assignee !== botLogin)) {
    return { eligible: false, reason: "Issue has a conflicting assignee" }
  }
  return { eligible: true }
}

export function evaluateWorkflowClaim(
  issue: Issue,
  botLogin: string,
  runId: string,
  requireComplete = true,
): Eligibility {
  const ownership = evaluateWorkflowOwnership(issue, botLogin, runId)
  if (!ownership.eligible) return ownership
  if (issue.state !== "open") return { eligible: false, reason: "Issue is not open" }
  if (issue.labels.includes("needs-discussion")) return { eligible: false, reason: "Issue needs discussion" }
  if (issue.labels.includes("needs-supervisor")) return { eligible: false, reason: "Issue needs supervisor attention" }
  if (issue.openBlockers.length) {
    const blockers = issue.openBlockers.map((blocker) => `#${blocker.number}`).join(", ")
    return { eligible: false, reason: `Issue is blocked by ${blockers}` }
  }
  if (!requireComplete) return { eligible: true }
  if (!issue.labels.includes("in-progress") || issue.labels.includes("ready")
    || issue.assignees.length !== 1 || issue.assignees[0] !== botLogin) {
    return { eligible: false, reason: "Workflow claim is incomplete" }
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

export function validateBranch(value: string): string {
  const branch = value.trim()
  const components = branch.split("/")
  if (!branch || branch.length > 255 || branch === "@" || branch.startsWith("-")
    || branch.includes("..") || branch.includes("@{") || /[\x00-\x20\x7f~^:?*[\]\\]/.test(branch)
    || branch.endsWith(".") || branch.endsWith("/") || branch.startsWith("/") || branch.includes("//")
    || components.some((component) => component.startsWith(".") || component.endsWith(".lock"))) {
    throw new Error(`Invalid Git branch: ${value}`)
  }
  return branch
}

export function reviewRunKey(repository: string, pullRequest: number, cycle: number): string {
  return `${validateRepository(repository)}!${pullRequest}/remediation-${cycle}`
}
