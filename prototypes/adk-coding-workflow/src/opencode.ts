import type { Issue } from "./domain"

export type OpenCodeResult = {
  status: "completed" | "blocked"
  sessionId: string
  question?: string
}

export interface OpenCodeService {
  implement(input: {
    issue: Issue
    repository: string
    worktree: string
    validationCommands: string[]
  }): Promise<OpenCodeResult>
}

export class OpenCodeClient implements OpenCodeService {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 30 * 60_000,
    private readonly pollMs = 1_000,
  ) {}

  async implement(input: {
    issue: Issue
    repository: string
    worktree: string
    validationCommands: string[]
  }): Promise<OpenCodeResult> {
    const session = await this.request<{ id: string }>("/session", {
      method: "POST",
      directory: input.worktree,
      body: {
        title: `Issue #${input.issue.number}: ${input.issue.title}`,
        permission: sessionPermissions(),
      },
    })
    await this.request(`/session/${session.id}/prompt_async`, {
      method: "POST",
      directory: input.worktree,
      body: {
        agent: "build",
        parts: [{ type: "text", text: implementationPrompt(input) }],
      },
    })

    const deadline = Date.now() + this.timeoutMs
    let missingStatusPolls = 0
    while (Date.now() < deadline) {
      const question = await this.pendingQuestion(session.id, input.worktree)
      if (question) {
        await this.abort(session.id, input.worktree)
        return { status: "blocked", sessionId: session.id, question }
      }
      const permission = await this.pendingPermission(session.id, input.worktree)
      if (permission) {
        await this.abort(session.id, input.worktree)
        return {
          status: "blocked",
          sessionId: session.id,
          question: `OpenCode requested an unsupported permission: ${permission}`,
        }
      }
      const statuses = await this.request<Record<string, { type: string }>>("/session/status", {
        directory: input.worktree,
      })
      const status = statuses[session.id]
      if (status?.type === "idle") {
        const outcome = await this.assistantOutcome(session.id, input.worktree)
        if (outcome.error) throw new Error(`OpenCode failed: ${outcome.error}`)
        if (outcome.completed) return { status: "completed", sessionId: session.id }
      }
      if (!status) {
        missingStatusPolls += 1
        if (missingStatusPolls >= 2) {
          const outcome = await this.assistantOutcome(session.id, input.worktree)
          if (outcome.error) throw new Error(`OpenCode failed: ${outcome.error}`)
          if (outcome.completed) return { status: "completed", sessionId: session.id }
        }
      } else {
        missingStatusPolls = 0
      }
      await Bun.sleep(this.pollMs)
    }
    await this.abort(session.id, input.worktree)
    throw new Error(`OpenCode session ${session.id} exceeded ${this.timeoutMs}ms`)
  }

  private async pendingQuestion(sessionId: string, directory: string): Promise<string | undefined> {
    const questions = await this.request<Array<{ sessionID: string; questions: Array<{ question: string }> }>>(
      "/question",
      { directory },
    )
    return questions.find((question) => question.sessionID === sessionId)?.questions.map((item) => item.question).join("; ")
  }

  private async pendingPermission(sessionId: string, directory: string): Promise<string | undefined> {
    const permissions = await this.request<Array<{ sessionID: string; permission: string }>>(
      "/permission",
      { directory },
    )
    return permissions.find((permission) => permission.sessionID === sessionId)?.permission
  }

  private async abort(sessionId: string, directory: string): Promise<void> {
    await this.request(`/session/${sessionId}/abort`, { method: "POST", directory }).catch(() => undefined)
  }

  private async assistantOutcome(
    sessionId: string,
    directory: string,
  ): Promise<{ completed: boolean; error?: string }> {
    const messages = await this.request<Array<{
      info?: { role?: string; time?: { completed?: number }; error?: { name?: string; data?: { message?: string } } }
      parts?: unknown[]
    }>>(
      `/session/${sessionId}/message`,
      { directory },
    )
    let assistant: (typeof messages)[number] | undefined
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.info?.role === "assistant") {
        assistant = messages[index]
        break
      }
    }
    if (assistant?.info?.error) {
      return {
        completed: false,
        error: assistant.info.error.data?.message ?? assistant.info.error.name ?? "assistant message failed",
      }
    }
    return { completed: Boolean(assistant?.info?.time?.completed) }
  }

  private async request<T = unknown>(
    path: string,
    options: { method?: string; directory?: string; body?: unknown } = {},
  ): Promise<T> {
    const url = new URL(path, this.baseUrl)
    if (options.directory) url.searchParams.set("directory", options.directory)
    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers: options.body ? { "Content-Type": "application/json" } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) {
      const body = await response.text()
      throw new Error(`OpenCode ${options.method ?? "GET"} ${path} failed (${response.status}): ${body.slice(0, 300)}`)
    }
    if (response.status === 204) return undefined as T
    return await response.json() as T
  }
}

export function sessionPermissions(): Array<{ permission: string; pattern: string; action: "allow" | "deny" }> {
  return [
    { permission: "*", pattern: "*", action: "deny" },
    { permission: "bash", pattern: "*", action: "deny" },
    { permission: "external_directory", pattern: "*", action: "deny" },
    { permission: "webfetch", pattern: "*", action: "deny" },
    { permission: "read", pattern: "*", action: "allow" },
    { permission: "edit", pattern: "*", action: "allow" },
    { permission: "glob", pattern: "*", action: "allow" },
    { permission: "grep", pattern: "*", action: "allow" },
    { permission: "list", pattern: "*", action: "allow" },
    { permission: "lsp", pattern: "*", action: "allow" },
    { permission: "todowrite", pattern: "*", action: "allow" },
    { permission: "question", pattern: "*", action: "allow" },
  ]
}

export function implementationPrompt(input: {
  issue: Issue
  repository: string
  validationCommands: string[]
}): string {
  const comments = input.issue.comments.length
    ? input.issue.comments.map((comment) => `@${comment.author}: ${comment.body}`).join("\n\n")
    : "No issue comments."
  const validation = input.validationCommands.length
    ? input.validationCommands.map((command) => `- ${command}`).join("\n")
    : "- Follow the repository's documented focused checks."
  return `You are implementing one assigned GitHub issue in an isolated worktree.

Repository: ${input.repository}
Issue: #${input.issue.number} ${input.issue.title}
URL: ${input.issue.url}

Issue body:
${input.issue.body}

Issue comments:
${comments}

Required validation:
${validation}

Read and follow all repository instruction files before editing. Implement only
this issue, add or update tests, and run focused validation where practical.
Do not commit, push, create a pull request, change GitHub state, or access
credentials. Leave the completed changes in the worktree. If a product or design
decision is genuinely required, ask one precise question rather than guessing.`
}
