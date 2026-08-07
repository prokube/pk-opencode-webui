import {
  ticketPriorities,
  validateBranch,
  type CandidateList,
  type DiscoveryProject,
  type DiscoveryRequest,
  type SelectedTicket,
  type TicketCandidate,
  type ValidatedSelection,
} from "./domain"

export const MAX_CANDIDATES = 50
const MAX_PROJECTS = 20

export type DiscoveryProjectSource = Pick<DiscoveryProject, "provider" | "project">

export const reviewedDiscoveryProjects: DiscoveryProjectSource[] = [
  { provider: "github", project: "prokube/pkui" },
]

export type DiscoveredTicketCandidate = {
  candidate: TicketCandidate
  authoredByAuthenticatedUser: boolean
  createdAt: string
}

export type ProviderCandidateList = {
  candidates: DiscoveredTicketCandidate[]
  truncated: boolean
}

export interface TicketDiscoveryProvider {
  readonly provider: string
  discover(project: DiscoveryProject): Promise<ProviderCandidateList>
  revalidate(candidate: TicketCandidate, baseBranch: string): Promise<void>
}

export function parseDiscoveryRequest(
  value: string,
  allowedProjects: DiscoveryProjectSource[] = reviewedDiscoveryProjects,
): DiscoveryRequest {
  const parsed: unknown = JSON.parse(value)
  if (!isRecord(parsed) || !Array.isArray(parsed.projects) || !parsed.projects.length
    || parsed.projects.length > MAX_PROJECTS) {
    throw new Error(`Discovery request must contain between 1 and ${MAX_PROJECTS} projects`)
  }
  const projects = parsed.projects.map((project): DiscoveryProject => {
    if (!isRecord(project) || typeof project.provider !== "string" || typeof project.project !== "string"
      || typeof project.suggestedBaseBranch !== "string") {
      throw new Error("Each discovery project requires provider, project, and suggestedBaseBranch")
    }
    const normalized = {
      provider: project.provider,
      project: validateProject(project.project),
      suggestedBaseBranch: validateBranch(project.suggestedBaseBranch),
    }
    assertAllowedProject(normalized, allowedProjects)
    return normalized
  })
  return { projects }
}

export function parseCandidateList(
  value: string,
  allowedProjects: DiscoveryProjectSource[] = reviewedDiscoveryProjects,
): CandidateList {
  const parsed: unknown = JSON.parse(value)
  if (!isRecord(parsed) || !Array.isArray(parsed.candidates) || typeof parsed.truncated !== "boolean"
    || parsed.candidates.length > MAX_CANDIDATES) {
    throw new Error("Invalid or oversized candidate list")
  }
  const candidates = parsed.candidates.map((candidate): TicketCandidate => {
    if (!isRecord(candidate) || typeof candidate.provider !== "string" || typeof candidate.project !== "string"
      || typeof candidate.number !== "number" || !Number.isSafeInteger(candidate.number) || candidate.number < 1
      || typeof candidate.title !== "string" || typeof candidate.author !== "string"
      || typeof candidate.priority !== "string" || !ticketPriorities.includes(candidate.priority as never)
      || typeof candidate.url !== "string" || typeof candidate.suggestedBaseBranch !== "string") {
      throw new Error("Invalid candidate")
    }
    const normalized = {
      provider: candidate.provider,
      project: validateProject(candidate.project),
      number: candidate.number,
      title: candidate.title,
      author: candidate.author,
      priority: candidate.priority as TicketCandidate["priority"],
      url: candidate.url,
      suggestedBaseBranch: validateBranch(candidate.suggestedBaseBranch),
    }
    assertAllowedProject(normalized, allowedProjects)
    if (normalized.provider === "github"
      && normalized.url !== `https://github.com/${normalized.project}/issues/${normalized.number}`) {
      throw new Error("Invalid GitHub candidate URL")
    }
    return normalized
  })
  return { candidates, truncated: parsed.truncated }
}

export function parseSelectedTicket(value: string): SelectedTicket {
  const parsed: unknown = JSON.parse(value)
  if (!isRecord(parsed) || typeof parsed.provider !== "string" || typeof parsed.project !== "string"
    || typeof parsed.number !== "number" || !Number.isSafeInteger(parsed.number) || parsed.number < 1) {
    throw new Error("Selected ticket requires provider, project, and a positive integer number")
  }
  return { provider: parsed.provider, project: validateProject(parsed.project), number: parsed.number }
}

export async function discoverTickets(
  request: DiscoveryRequest,
  providers: TicketDiscoveryProvider[],
  allowedProjects: DiscoveryProjectSource[] = reviewedDiscoveryProjects,
): Promise<CandidateList> {
  const candidates: DiscoveredTicketCandidate[] = []
  let truncated = false
  for (const project of request.projects) {
    assertAllowedProject(project, allowedProjects)
    const provider = providers.find((item) => item.provider === project.provider)
    if (!provider) throw new Error(`Unsupported ticket provider: ${project.provider}`)
    const result = await provider.discover(project)
    candidates.push(...result.candidates)
    truncated ||= result.truncated
  }
  candidates.sort((left, right) => Number(right.authoredByAuthenticatedUser) - Number(left.authoredByAuthenticatedUser)
    || ticketPriorities.indexOf(left.candidate.priority) - ticketPriorities.indexOf(right.candidate.priority)
    || left.createdAt.localeCompare(right.createdAt)
    || left.candidate.project.localeCompare(right.candidate.project)
    || left.candidate.number - right.candidate.number)
  if (candidates.length > MAX_CANDIDATES) truncated = true
  return { candidates: candidates.slice(0, MAX_CANDIDATES).map((item) => item.candidate), truncated }
}

export async function revalidateSelection(input: {
  candidateList: CandidateList
  selectedTicket: SelectedTicket
  baseBranch: string
  providers: TicketDiscoveryProvider[]
}): Promise<ValidatedSelection> {
  const candidate = input.candidateList.candidates.find((item) => item.provider === input.selectedTicket.provider
    && item.project === input.selectedTicket.project && item.number === input.selectedTicket.number)
  if (!candidate) throw new Error("Selected ticket was not in the published candidate list")
  const provider = input.providers.find((item) => item.provider === candidate.provider)
  if (!provider) throw new Error(`Unsupported ticket provider: ${candidate.provider}`)
  const baseBranch = validateBranch(input.baseBranch)
  await provider.revalidate(candidate, baseBranch)
  return { ...input.selectedTicket, baseBranch }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function validateProject(value: string): string {
  const project = value.trim()
  if (!project || project.length > 200 || /[\x00-\x1f\x7f]/.test(project)) {
    throw new Error("Invalid provider project")
  }
  return project
}

function assertAllowedProject(project: DiscoveryProjectSource, allowedProjects: DiscoveryProjectSource[]): void {
  if (!allowedProjects.some((allowed) => allowed.provider === project.provider && allowed.project === project.project)) {
    throw new Error(`Discovery project is not allowlisted: ${project.provider}/${project.project}`)
  }
}
