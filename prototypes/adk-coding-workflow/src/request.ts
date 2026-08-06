import { validateRepository, type RunMode, type WorkflowRequest } from "./domain"
import { repositoryCommands, repositoryPolicy } from "./policy"

export type TicketReference = {
  provider: "github"
  repository: string
  number: number
}

export type RepositoryTarget = {
  repository: string
  baseBranch?: string
}

export type CodingRequest = {
  ticket: TicketReference
  targets: RepositoryTarget[]
  publish: boolean
}

export function workflowRequest(input: {
  request: CodingRequest
  mode: RunMode
  workspaceRoot: string
  botLogin?: string
}): WorkflowRequest {
  if (input.request.targets.length !== 1) {
    throw new Error("The current milestone requires exactly one target repository")
  }
  const ticketRepository = validateRepository(input.request.ticket.repository)
  const targetRepository = validateRepository(input.request.targets[0]!.repository)
  if (ticketRepository !== targetRepository) {
    throw new Error("The current milestone requires ticket and target repository to match")
  }
  if (!Number.isSafeInteger(input.request.ticket.number) || input.request.ticket.number < 1) {
    throw new Error("GitHub issue number must be a positive integer")
  }
  const policy = repositoryPolicy(targetRepository)
  return {
    repository: targetRepository,
    issueNumber: input.request.ticket.number,
    mode: input.mode,
    baseBranch: input.request.targets[0]!.baseBranch ?? policy.baseBranch,
    workspaceRoot: input.workspaceRoot,
    validationCommands: repositoryCommands(targetRepository),
    botLogin: input.botLogin,
  }
}
