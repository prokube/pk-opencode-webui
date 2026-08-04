import { evaluateEligibility, type Issue } from "./domain"

type GitHubIssue = {
  number: number
  title: string
  body: string | null
  state: string
  html_url: string
  labels: Array<string | { name?: string }>
  assignees?: Array<{ login: string }>
}

export interface GitHubService {
  getIssue(repository: string, issueNumber: number): Promise<Issue>
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

export class GitHubClient implements GitHubService {
  constructor(
    private readonly token?: string,
    private readonly apiUrl = "https://api.github.com",
  ) {}

  async getIssue(repository: string, issueNumber: number): Promise<Issue> {
    const issue = await this.request<GitHubIssue>(`/repos/${repository}/issues/${issueNumber}`)
    const comments = await this.request<Array<{ user: { login: string }; body: string }>>(
      `/repos/${repository}/issues/${issueNumber}/comments?per_page=100`,
    )
    const blockers = await this.request<Array<{ number: number; title: string; state: string }>>(
      `/repos/${repository}/issues/${issueNumber}/dependencies/blocked_by`,
    )
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

  async claimIssue(repository: string, issue: Issue, botLogin: string, runId: string): Promise<void> {
    this.requireToken()
    const current = await this.getIssue(repository, issue.number)
    const eligibility = evaluateEligibility(current)
    if (!eligibility.eligible) throw new Error(`Issue changed before claim: ${eligibility.reason}`)
    await this.request(`/repos/${repository}/issues/${issue.number}/labels`, {
      method: "POST",
      body: { labels: ["in-progress"] },
    })
    await this.request(`/repos/${repository}/issues/${issue.number}/assignees`, {
      method: "POST",
      body: { assignees: [botLogin] },
    })
    await this.request(`/repos/${repository}/issues/${issue.number}/labels/ready`, { method: "DELETE" })
    await this.comment(repository, issue.number, `Coding workflow \`${runId}\` claimed this issue.`)
  }

  async findOpenPullRequest(repository: string, branch: string, issueNumber: number): Promise<string | undefined> {
    const pulls = await this.request<Array<{ html_url: string; body?: string | null; head?: { ref?: string } }>>(
      `/repos/${repository}/pulls?state=open&per_page=100`,
    )
    const closesIssue = new RegExp(`(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+(?:${repository})?#${issueNumber}\\b`, "i")
    return pulls.find((pull) => pull.head?.ref === branch || closesIssue.test(pull.body ?? ""))?.html_url
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

  private async request<T>(
    path: string,
    options: {
      method?: string
      body?: unknown
    } = {},
  ): Promise<T> {
    const response = await fetch(new URL(path, this.apiUrl), {
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
    if (!response.ok) {
      const body = await response.text()
      throw new Error(`GitHub ${options.method ?? "GET"} ${path} failed (${response.status}): ${body.slice(0, 300)}`)
    }
    if (response.status === 204) return undefined as T
    return await response.json() as T
  }
}
