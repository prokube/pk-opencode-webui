import { mkdirSync } from "node:fs"
import { dirname } from "node:path"

import { runPhases, type RunPhase, type WorkflowResult } from "./domain"

const MAX_SUMMARY_LENGTH = 1_000
const MAX_BRANCH_LENGTH = 255
const MAX_CHANGED_FILES = 100
const MAX_CHANGED_FILE_LENGTH = 512
const githubPullRequestUrl = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/
const branchName = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/
const sensitiveSummary = /PRIVATE KEY|\b(?:token|password|secret|api[-_]?key|authorization)\s*[:=]|\bbearer\s+\S{8,}|\b(?:ghp_|github_pat_|sk-|xox[baprs]-)\S{10,}/i

export type PublicWorkflowResult = {
  phase: RunPhase
  summary: string
  branch?: string
  pullRequestUrl?: string
  changedFiles: string[]
  changedFilesTruncated: boolean
}

function safeChangedFile(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > MAX_CHANGED_FILE_LENGTH) return false
  if (value.startsWith("/") || value.startsWith("~")) return false
  if (value.split("/").some((part) => !part || part === "." || part === "..")) return false
  return !/[\u0000-\u001f\u007f]/.test(value)
}

export function toPublicWorkflowResult(
  value: unknown,
  argoStatus = "Unknown",
): PublicWorkflowResult {
  const input = value && typeof value === "object" ? value as Partial<WorkflowResult> : {}
  const phase = typeof input.phase === "string" && runPhases.includes(input.phase as RunPhase)
    ? input.phase as RunPhase
    : "failed"
  const fallbackSummary = `Workflow ended with Argo status ${argoStatus.slice(0, 50)} before producing a result`
  const rawSummary = typeof input.summary === "string" ? input.summary.replaceAll("\0", " ").trim() : ""
  const summary = rawSummary
    ? sensitiveSummary.test(rawSummary)
      ? "Result summary contained sensitive credential material and was redacted."
      : rawSummary.slice(0, MAX_SUMMARY_LENGTH)
    : fallbackSummary
  const inputChangedFiles = Array.isArray(input.changedFiles) ? input.changedFiles : []
  const rawChangedFiles = inputChangedFiles.filter(safeChangedFile)
  const result: PublicWorkflowResult = {
    phase,
    summary,
    changedFiles: rawChangedFiles
      .slice(0, MAX_CHANGED_FILES)
      .map((file) => file.slice(0, MAX_CHANGED_FILE_LENGTH)),
    changedFilesTruncated: (
      rawChangedFiles.length > MAX_CHANGED_FILES
      || rawChangedFiles.length !== inputChangedFiles.length
    ),
  }
  if (
    typeof input.branch === "string"
    && input.branch.length <= MAX_BRANCH_LENGTH
    && branchName.test(input.branch)
    && input.branch.split("/").every((part) => part && part !== "." && part !== "..")
  ) {
    result.branch = input.branch
  }
  if (typeof input.pullRequestUrl === "string" && githubPullRequestUrl.test(input.pullRequestUrl)) {
    result.pullRequestUrl = input.pullRequestUrl
  }
  return result
}

export async function main(): Promise<void> {
  const inputPath = process.env.PK_WORKFLOW_RESULT_PATH ?? "/workspace/.workflow-output/result.json"
  const outputPath = process.env.PK_WORKFLOW_PUBLIC_RESULT_PATH ?? "/tmp/workflow-result.json"
  let input: unknown
  try {
    input = await Bun.file(inputPath).json()
  } catch {
    input = undefined
  }
  const result = toPublicWorkflowResult(input, process.env.PK_WORKFLOW_STATUS)
  mkdirSync(dirname(outputPath), { recursive: true })
  await Bun.write(outputPath, `${JSON.stringify(result)}\n`)
  console.log(JSON.stringify(result, null, 2))
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
