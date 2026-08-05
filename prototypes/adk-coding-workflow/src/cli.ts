import { mkdirSync } from "node:fs"
import { join, resolve } from "node:path"

import { CodingWorkflowAgent, runWithAdk } from "./adk-agent"
import { runModes, type RunMode, type WorkflowRequest } from "./domain"
import { GitHubClient } from "./github"
import { OpenCodeClient } from "./opencode"
import { BunProcessRunner } from "./process"
import { CodingWorkflow } from "./workflow"
import { WorkspaceService } from "./workspace"

type CliOptions = WorkflowRequest & {
  opencodeUrl: string
  validatedPatchSha?: string
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
    validatedPatchSha: values.get("--validated-patch-sha")?.at(-1),
  }
}

export async function main(argv = Bun.argv.slice(2)): Promise<number> {
  const options = parseArgs(argv)
  const token = process.env.GH_TOKEN
  const runner = new BunProcessRunner()
  const workspaces = new WorkspaceService(runner)
  const runId = process.env.PK_WORKFLOW_RUN_ID
  if (options.mode === "attest") {
    if (!runId) throw new Error("PK_WORKFLOW_RUN_ID is required in attest mode")
    if (!options.validatedPatchSha) throw new Error("--validated-patch-sha is required in attest mode")
    const attestation = await workspaces.createAttestation({
      issueNumber: options.issueNumber,
      runId,
      workspaceRoot: options.workspaceRoot,
      expectedPatchSha256: options.validatedPatchSha,
    })
    await Bun.write(join(options.workspaceRoot, runId, "validation.json"), `${JSON.stringify(attestation, null, 2)}\n`)
    console.log(JSON.stringify(attestation, null, 2))
    return 0
  }
  const providerID = process.env.OPENCODE_PROVIDER_ID
  const modelID = process.env.OPENCODE_MODEL_ID
  if (Boolean(providerID) !== Boolean(modelID)) {
    throw new Error("OPENCODE_PROVIDER_ID and OPENCODE_MODEL_ID must be configured together")
  }
  const workflow = new CodingWorkflow(
    new GitHubClient(token),
    workspaces,
    new OpenCodeClient(options.opencodeUrl, undefined, undefined, providerID && modelID ? { providerID, modelID } : undefined),
    token,
    runId ? () => runId : undefined,
  )
  const result = await runWithAdk(workflow, options)
  const outputDir = process.env.PK_WORKFLOW_OUTPUT_DIR
  if (outputDir) {
    mkdirSync(outputDir, { recursive: true })
    await Bun.write(join(outputDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`)
    if (
      !["finalize", "publish"].includes(options.mode)
      && ["completed", "validating"].includes(result.phase)
      && result.workspace
      && result.changedFiles
    ) {
      await Bun.write(join(outputDir, "changes.patch"), await workspaces.createPatch(result.workspace, result.changedFiles))
    }
  }
  console.log(JSON.stringify(result, null, 2))
  return result.phase === "completed" || (options.mode === "implement" && result.phase === "validating") ? 0 : 1
}

if (import.meta.main) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
