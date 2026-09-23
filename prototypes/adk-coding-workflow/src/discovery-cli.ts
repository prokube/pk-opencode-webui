import { mkdirSync } from "node:fs"
import { join } from "node:path"

import {
  discoverTickets,
  parseCandidateList,
  parseDiscoveryRequest,
  parseSelectedTicket,
  revalidateSelection,
  selectFirstCandidate,
} from "./discovery"
import { writeClaimRecord } from "./claim-record"
import { GitHubClient } from "./github"

type DiscoveryCliOptions =
  | { mode: "discover"; request: string; outputDir: string }
  | { mode: "select-first"; candidates: string; outputDir: string }
  | { mode: "revalidate"; request: string; candidates: string; selectedTicket: string; baseBranch: string; outputDir: string }
  | { mode: "claim"; request: string; selectedTicket: string }

export function parseDiscoveryArgs(argv: string[]): DiscoveryCliOptions {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith("--") || !value) throw new Error(`Invalid argument: ${key ?? ""}`)
    values.set(key, value)
  }
  const required = (key: string): string => {
    const value = values.get(key)
    if (!value) throw new Error(`Missing required option ${key}`)
    return value
  }
  const mode = required("--mode")
  if (mode === "claim") {
    return { mode, request: required("--request"), selectedTicket: required("--selected-ticket") }
  }
  const outputDir = required("--output-dir")
  if (mode === "discover") return { mode, request: required("--request"), outputDir }
  if (mode === "select-first") {
    return { mode, candidates: required("--candidates"), outputDir }
  }
  if (mode === "revalidate") {
    return {
      mode,
      request: required("--request"),
      candidates: required("--candidates"),
      selectedTicket: required("--selected-ticket"),
      baseBranch: required("--base-branch"),
      outputDir,
    }
  }
  throw new Error(`Invalid --mode: ${mode}`)
}

export async function discoveryMain(argv = Bun.argv.slice(2)): Promise<number> {
  const options = parseDiscoveryArgs(argv)
  const provider = new GitHubClient(process.env.GH_TOKEN)
  if (options.mode === "claim") {
    const runId = process.env.PK_WORKFLOW_RUN_ID
    if (!runId) throw new Error("PK_WORKFLOW_RUN_ID is required in claim mode")
    const selected = parseSelectedTicket(options.selectedTicket)
    const request = parseDiscoveryRequest(options.request)
    if (selected.provider !== provider.provider) throw new Error(`Unsupported ticket provider: ${selected.provider}`)
    const currentLogin = await provider.getAuthenticatedLogin()
    const configuredLogin = process.env.PK_WORKFLOW_BOT_LOGIN?.trim()
    if (configuredLogin && configuredLogin !== currentLogin) {
      throw new Error(`Configured bot login ${configuredLogin} does not match authenticated GitHub user ${currentLogin}`)
    }
    const claimFile = process.env.PK_WORKFLOW_CLAIM_FILE
    if (!claimFile) throw new Error("PK_WORKFLOW_CLAIM_FILE is required in claim mode")
    await writeClaimRecord(claimFile, {
      version: 1,
      ...selected,
      botLogin: currentLogin,
      runId,
    })
    const issue = await provider.getIssue(selected.project, selected.number)
    await provider.claimIssue(selected.project, issue, currentLogin, runId, request.labelPolicy)
    console.log(JSON.stringify({ ...selected, claimedBy: currentLogin, runId }))
    return 0
  }
  mkdirSync(options.outputDir, { recursive: true })
  if (options.mode === "discover") {
    const result = await discoverTickets(parseDiscoveryRequest(options.request), [provider])
    await Bun.write(join(options.outputDir, "candidate-list.json"), JSON.stringify(result))
    console.log(JSON.stringify(result))
    return 0
  }
  if (options.mode === "select-first") {
    const selected = selectFirstCandidate(parseCandidateList(options.candidates))
    await Promise.all([
      Bun.write(join(options.outputDir, "selected-ticket.json"), JSON.stringify(selected.selectedTicket)),
      Bun.write(join(options.outputDir, "base-branch"), selected.baseBranch),
    ])
    console.log(JSON.stringify(selected))
    return 0
  }
  const request = parseDiscoveryRequest(options.request)
  const result = await revalidateSelection({
    candidateList: parseCandidateList(options.candidates),
    selectedTicket: parseSelectedTicket(options.selectedTicket),
    baseBranch: options.baseBranch,
    labelPolicy: request.labelPolicy,
    providers: [provider],
  })
  await Promise.all([
    Bun.write(join(options.outputDir, "ticket-repository"), result.project),
    Bun.write(join(options.outputDir, "target-repository"), result.project),
    Bun.write(join(options.outputDir, "issue"), String(result.number)),
    Bun.write(join(options.outputDir, "base"), result.baseBranch),
  ])
  console.log(JSON.stringify(result))
  return 0
}

if (import.meta.main) {
  discoveryMain().then((code) => process.exit(code)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
