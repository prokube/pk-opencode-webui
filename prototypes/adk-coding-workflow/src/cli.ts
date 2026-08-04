import { resolve } from "node:path"

import { CodingWorkflowAgent, runWithAdk } from "./adk-agent"
import { runModes, type RunMode, type WorkflowRequest } from "./domain"
import { GitHubClient } from "./github"
import { OpenCodeClient } from "./opencode"
import { BunProcessRunner } from "./process"
import { CodingWorkflow } from "./workflow"
import { WorkspaceService } from "./workspace"

type CliOptions = WorkflowRequest & {
  opencodeUrl: string
}

export function parseArgs(argv: string[]): CliOptions {
  const values = new Map<string, string[]>()
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (!key?.startsWith("--")) throw new Error(`Unexpected argument: ${key}`)
    const value = argv[index + 1]
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`)
    values.set(key, [...(values.get(key) ?? []), value])
    index += 1
  }
  const required = (key: string): string => {
    const value = values.get(key)?.at(-1)
    if (!value) throw new Error(`Missing required option ${key}`)
    return value
  }
  const mode = (values.get("--mode")?.at(-1) ?? "plan") as RunMode
  if (!runModes.includes(mode)) throw new Error(`Invalid --mode: ${mode}`)
  const issueNumber = Number(required("--issue"))
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) throw new Error("--issue must be a positive integer")
  const validationCommands = values.get("--validate") ?? []
  if (mode === "publish" && validationCommands.length === 0) {
    throw new Error("Publish mode requires at least one --validate command")
  }
  return {
    repository: required("--repository"),
    issueNumber,
    mode,
    baseBranch: values.get("--base")?.at(-1) ?? "main",
    workspaceRoot: resolve(values.get("--workspace-root")?.at(-1) ?? ".data/workspaces"),
    validationCommands,
    botLogin: values.get("--bot-login")?.at(-1),
    opencodeUrl: values.get("--opencode-url")?.at(-1) ?? "http://127.0.0.1:4096",
  }
}

export async function main(argv = Bun.argv.slice(2)): Promise<number> {
  const options = parseArgs(argv)
  const token = process.env.GH_TOKEN
  const runner = new BunProcessRunner()
  const workflow = new CodingWorkflow(
    new GitHubClient(token),
    new WorkspaceService(runner),
    new OpenCodeClient(options.opencodeUrl),
    token,
  )
  const result = await runWithAdk(workflow, options)
  console.log(JSON.stringify(result, null, 2))
  return result.phase === "completed" ? 0 : 1
}

if (import.meta.main) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
