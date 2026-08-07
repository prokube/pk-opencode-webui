import { branchForIssue, evaluateEligibility, evaluateWorkflowClaim, evaluateWorkflowOwnership, hasWorkflowClaim, isClaimedByWorkflow, validateRepository, workflowClaimComment, type DiscoveryProject, type Issue, type TicketCandidate, type TicketPriority } from "./domain"
import type { ProviderCandidateList, TicketDiscoveryProvider } from "./discovery"

const MAX_DISCOVERY_ISSUES = 500
const MAX_CANDIDATES = 50

type GitHubIssue = {
  number: number
  title: string
  body: string | null
  state: string
  html_url: string
  labels: Array<string | { name?: string }>
  assignees?: Array<{ login: string }>
  user?: { login?: string }
  created_at?: string
  pull_request?: unknown
}

type GitHubPull = { html_url: string; body?: string | null; head?: { ref?: string } }

export interface GitHubService {
  getIssue(repository: string, issueNumber: number): Promise<Issue>
  getAuthenticatedLogin(): Promise<string>
  findOpenPullRequest(repository: string, branch: string, issueNumber: number): Promise<string | undefined>
  claimIssue(repository: string, issue: Issue, botLogin: string, runId: string): Promise<void>
  createPullRequest(input: {
    repository: string
    issue: Issue
    branch: string
    baseBranch: string
    changedFiles: string[]
  }): Promise<string>
  comment(repository: string, issueNumber: number, body: string): Promise<void>
}

export class GitHubClient implements GitHubService, TicketDiscoveryProvider {
  readonly provider = "github"

  constructor(
    private readonly token?: string,
    private readonly apiUrl = "https://api.github.com",
  ) {}

  async getIssue(repository: string, issueNumber: number): Promise<Issue> {
    const issue = await this.request<GitHubIssue>(`/repos/${repository}/issues/${issueNumber}`)
    const comments: Array<{ user: { login: string }; body: string }> = []
    for (let page = 1; ; page += 1) {
      const batch = await this.request<Array<{ user: { login: string }; body: string }>>(
        `/repos/${repository}/issues/${issueNumber}/comments?per_page=100&page=${page}`,
      )
      comments.push(...batch)
      if (batch.length < 100) break
    }
    const blockers: Array<{ number: number; title: string; state: string }> = []
    for (let page = 1; ; page += 1) {
      const batch = await this.request<Array<{ number: number; title: string; state: string }>>(
        `/repos/${repository}/issues/${issueNumber}/dependencies/blocked_by?per_page=100&page=${page}`,
      )
      blockers.push(...batch)
      if (batch.length < 100) break
    }
    return {
      number: issue.number,
      title: issue.title,
      body: issue.body ?? "",
      state: issue.state,
      labels: issue.labels.flatMap((label) => typeof label === "string" ? [label] : label.name ? [label.name] : []),
      assignees: issue.assignees?.map((assignee) => assignee.login) ?? [],
      comments: comments.map((comment) => ({ author: comment.user.login, body: comment.body })),
      openBlockers: blockers.filter((blocker) => blocker.state === "open").map((blocker) => ({
        number: blocker.number,
        title: blocker.title,
      })),
      url: issue.html_url,
    }
  }

  async getAuthenticatedLogin(): Promise<string> {
    this.requireToken()
    const user = await this.request<{ login?: string }>("/user")
    if (!user.login) throw new Error("GitHub did not return an authenticated login")
    return user.login
  }

  async discover(project: DiscoveryProject): Promise<ProviderCandidateList> {
    const repository = validateRepository(project.project)
    const login = await this.getAuthenticatedLogin()
    const issues: GitHubIssue[] = []
    let scanTruncated = false
    let scanned = 0
    for (let page = 1; scanned < MAX_DISCOVERY_ISSUES; page += 1) {
      const batch = await this.request<GitHubIssue[]>(
        `/repos/${repository}/issues?state=open&labels=ready&sort=created&direction=asc&per_page=100&page=${page}`,
      )
      const bounded = batch.slice(0, MAX_DISCOVERY_ISSUES - scanned)
      scanned += bounded.length
      issues.push(...bounded.filter((issue) => !issue.pull_request))
      if (batch.length < 100) break
      if (scanned === MAX_DISCOVERY_ISSUES) scanTruncated = true
    }
    const pulls = await this.listPullRequests(repository, "open")
    const eligible: ProviderCandidateList["candidates"] = []
    for (const raw of issues) {
      const issue = await this.getEligibilityIssue(repository, raw)
      if (!evaluateEligibility(issue).eligible) continue
      const branch = branchForIssue(issue.number)
      if (this.pullForIssue(pulls, repository, branch, issue.number)
        || await this.branchExists(repository, branch)) continue
      const author = raw.user?.login ?? "unknown"
      eligible.push({
        candidate: {
          provider: this.provider,
          project: repository,
          number: issue.number,
          title: issue.title,
          author,
          priority: priorityForLabels(issue.labels),
          url: issue.url,
          suggestedBaseBranch: project.suggestedBaseBranch,
        },
        authoredByAuthenticatedUser: author.toLowerCase() === login.toLowerCase(),
        createdAt: raw.created_at ?? "",
      })
    }
    eligible.sort((left, right) => Number(right.authoredByAuthenticatedUser) - Number(left.authoredByAuthenticatedUser)
      || priorityRank(left.candidate.priority) - priorityRank(right.candidate.priority)
      || left.createdAt.localeCompare(right.createdAt)
      || left.candidate.project.localeCompare(right.candidate.project)
      || left.candidate.number - right.candidate.number)
    return {
      candidates: eligible.slice(0, MAX_CANDIDATES),
      truncated: scanTruncated || eligible.length > MAX_CANDIDATES,
    }
  }

  async revalidate(candidate: TicketCandidate, baseBranch: string): Promise<void> {
    const repository = validateRepository(candidate.project)
    const raw = await this.request<GitHubIssue>(`/repos/${repository}/issues/${candidate.number}`)
    const issue = await this.getEligibilityIssue(repository, raw)
    const eligibility = evaluateEligibility(issue)
    if (!eligibility.eligible) throw new Error(`Selected issue is no longer eligible: ${eligibility.reason}`)
    const branch = branchForIssue(candidate.number)
    const existing = await this.findOpenPullRequest(repository, branch, candidate.number)
    if (existing) throw new Error(`Selected issue already has an open pull request: ${existing}`)
    if (await this.branchExists(repository, branch)) {
      throw new Error(`Selected issue branch already exists: ${branch}`)
    }
    if (!await this.branchExists(repository, baseBranch)) {
      throw new Error(`Selected base branch does not exist: ${baseBranch}`)
    }
  }

  async claimIssue(repository: string, issue: Issue, botLogin: string, runId: string): Promise<void> {
    this.requireToken()
    let current = await this.getIssue(repository, issue.number)
    const hasMarker = isClaimedByWorkflow(current, botLogin, runId)
    if (hasMarker) {
      const ownership = evaluateWorkflowClaim(current, botLogin, runId, false)
      if (!ownership.eligible) throw new Error(`Issue claim conflict: ${ownership.reason}`)
    } else {
      if (hasWorkflowClaim(current)) throw new Error("Issue claim conflict: Issue has a conflicting workflow claim")
      const eligibility = evaluateEligibility(current)
      if (!eligibility.eligible) throw new Error(`Issue changed before claim: ${eligibility.reason}`)
      await this.comment(repository, issue.number, workflowClaimComment(runId))
      current = await this.getIssue(repository, issue.number)
      const ownership = evaluateWorkflowClaim(current, botLogin, runId, false)
      if (!ownership.eligible) throw new Error(`Issue claim conflict: ${ownership.reason}`)
    }
    if (!current.labels.includes("in-progress")) {
      await this.request(`/repos/${repository}/issues/${issue.number}/labels`, {
        method: "POST",
        body: { labels: ["in-progress"] },
      })
    }
    if (!current.assignees.includes(botLogin)) {
      await this.request(`/repos/${repository}/issues/${issue.number}/assignees`, {
        method: "POST",
        body: { assignees: [botLogin] },
      })
    }
    if (current.labels.includes("ready")) {
      await this.request(`/repos/${repository}/issues/${issue.number}/labels/ready`, { method: "DELETE" })
    }
  }

  async findOpenPullRequest(repository: string, branch: string, issueNumber: number): Promise<string | undefined> {
    return this.findPullRequest(repository, branch, issueNumber, "open")
  }

  async findPullRequest(
    repository: string,
    branch: string,
    issueNumber: number,
    state: "open" | "all" = "all",
  ): Promise<string | undefined> {
    return this.pullForIssue(await this.listPullRequests(repository, state), repository, branch, issueNumber)?.html_url
  }

  async releaseIssueClaim(
    repository: string,
    issueNumber: number,
    botLogin: string,
    runId: string,
    reason: string,
  ): Promise<boolean> {
    this.requireToken()
    const current = await this.getIssue(repository, issueNumber)
    const ownership = evaluateWorkflowOwnership(current, botLogin, runId)
    if (!ownership.eligible) throw new Error(`Issue cleanup conflict: ${ownership.reason}`)
    if (current.state !== "open") return false
    if (!current.labels.includes("needs-supervisor")) {
      await this.request(`/repos/${repository}/issues/${issueNumber}/labels`, {
        method: "POST",
        body: { labels: ["needs-supervisor"] },
      })
    }
    if (current.labels.includes("in-progress")) {
      await this.request(`/repos/${repository}/issues/${issueNumber}/labels/in-progress`, { method: "DELETE" })
    }
    if (current.labels.includes("ready")) {
      await this.request(`/repos/${repository}/issues/${issueNumber}/labels/ready`, { method: "DELETE" })
    }
    if (current.assignees.includes(botLogin)) {
      await this.request(`/repos/${repository}/issues/${issueNumber}/assignees`, {
        method: "DELETE",
        body: { assignees: [botLogin] },
      })
    }
    const prefix = `Coding workflow \`${runId}\` stopped before creating a pull request.`
    if (!current.comments.some((comment) => comment.author === botLogin && comment.body.startsWith(prefix))) {
      const bounded = reason.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 300)
      await this.comment(
        repository,
        issueNumber,
        `${prefix} Added \`needs-supervisor\`: ${bounded || "workflow did not complete"}.`,
      )
    }
    return true
  }

  async createPullRequest(input: {
    repository: string
    issue: Issue
    branch: string
    baseBranch: string
    changedFiles: string[]
  }): Promise<string> {
    this.requireToken()
    const pull = await this.request<{ html_url: string }>(`/repos/${input.repository}/pulls`, {
      method: "POST",
      body: {
        title: input.issue.title,
        head: input.branch,
        base: input.baseBranch,
        body: [
          "## Summary",
          "",
          `Automated implementation for #${input.issue.number}.`,
          "",
          "## Changed Files",
          "",
          ...input.changedFiles.map((file) => `- \`${file}\``),
          "",
          `Closes #${input.issue.number}`,
        ].join("\n"),
      },
    })
    return pull.html_url
  }

  async comment(repository: string, issueNumber: number, body: string): Promise<void> {
    this.requireToken()
    await this.request(`/repos/${repository}/issues/${issueNumber}/comments`, { method: "POST", body: { body } })
  }

  private requireToken(): void {
    if (!this.token) throw new Error("GH_TOKEN is required for GitHub mutations")
  }

  private async getEligibilityIssue(repository: string, raw: GitHubIssue): Promise<Issue> {
    const blockers: Array<{ number: number; title: string; state: string }> = []
    for (let page = 1; ; page += 1) {
      const batch = await this.request<Array<{ number: number; title: string; state: string }>>(
        `/repos/${repository}/issues/${raw.number}/dependencies/blocked_by?per_page=100&page=${page}`,
      )
      const open = batch.find((blocker) => blocker.state === "open")
      if (open) {
        blockers.push(open)
        break
      }
      if (batch.length < 100) break
    }
    return {
      number: raw.number,
      title: raw.title,
      body: raw.body ?? "",
      state: raw.state,
      labels: raw.labels.flatMap((label) => typeof label === "string" ? [label] : label.name ? [label.name] : []),
      assignees: raw.assignees?.map((assignee) => assignee.login) ?? [],
      comments: [],
      openBlockers: blockers.map((blocker) => ({ number: blocker.number, title: blocker.title })),
      url: raw.html_url,
    }
  }

  private async listPullRequests(repository: string, state: "open" | "all"): Promise<GitHubPull[]> {
    const pulls: GitHubPull[] = []
    for (let page = 1; ; page += 1) {
      const batch = await this.request<GitHubPull[]>(`/repos/${repository}/pulls?state=${state}&per_page=100&page=${page}`)
      pulls.push(...batch)
      if (batch.length < 100) return pulls
    }
  }

  private pullForIssue(
    pulls: GitHubPull[],
    repository: string,
    branch: string,
    issueNumber: number,
  ): GitHubPull | undefined {
    const closesIssue = new RegExp(`(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+(?:${repository})?#${issueNumber}\\b`, "i")
    return pulls.find((pull) => pull.head?.ref === branch || closesIssue.test(pull.body ?? ""))
  }

  private async branchExists(repository: string, branch: string): Promise<boolean> {
    const response = await this.fetch(`/repos/${repository}/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`)
    if (response.status === 404) return false
    if (!response.ok) throw await this.responseError(response, "GET", `/repos/${repository}/git/ref/heads/${branch}`)
    return true
  }

  private async request<T>(
    path: string,
    options: {
      method?: string
      body?: unknown
    } = {},
  ): Promise<T> {
    const response = await this.fetch(path, options)
    if (!response.ok) throw await this.responseError(response, options.method ?? "GET", path)
    if (response.status === 204) return undefined as T
    return await response.json() as T
  }

  private async fetch(path: string, options: { method?: string; body?: unknown } = {}): Promise<Response> {
    return await fetch(new URL(path, this.apiUrl), {
      method: options.method ?? "GET",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "prokube-adk-coding-workflow-prototype",
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(20_000),
    })
  }

  private async responseError(response: Response, method: string, path: string): Promise<Error> {
    const body = await response.text()
    return new Error(`GitHub ${method} ${path} failed (${response.status}): ${body.slice(0, 300)}`)
  }
}

function priorityForLabels(labels: string[]): TicketPriority {
  for (const priority of ["critical", "high", "medium", "low"] as const) {
    if (labels.includes(`priority:${priority}`)) return priority
  }
  return "medium"
}

function priorityRank(priority: TicketPriority): number {
  return ["critical", "high", "medium", "low"].indexOf(priority)
}
