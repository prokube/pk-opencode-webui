import { mkdirSync, renameSync } from "node:fs"
import { dirname } from "node:path"

import { validateRepository, type SelectedTicket } from "./domain"

export type WorkflowClaimRecord = SelectedTicket & {
  version: 1
  botLogin: string
  runId: string
}

export function parseClaimRecord(value: string): WorkflowClaimRecord {
  const parsed: unknown = JSON.parse(value)
  if (!isRecord(parsed) || parsed.version !== 1 || parsed.provider !== "github"
    || typeof parsed.project !== "string" || typeof parsed.number !== "number"
    || !Number.isSafeInteger(parsed.number) || parsed.number < 1
    || typeof parsed.botLogin !== "string" || !/^[A-Za-z0-9-]{1,39}$/.test(parsed.botLogin)
    || typeof parsed.runId !== "string" || !/^[a-z0-9](?:[-a-z0-9]{0,251}[a-z0-9])?$/.test(parsed.runId)) {
    throw new Error("Invalid workflow claim record")
  }
  return {
    version: 1,
    provider: "github",
    project: validateRepository(parsed.project),
    number: parsed.number,
    botLogin: parsed.botLogin,
    runId: parsed.runId,
  }
}

export async function writeClaimRecord(path: string, record: WorkflowClaimRecord): Promise<void> {
  const serialized = `${JSON.stringify(record)}\n`
  if (await Bun.file(path).exists()) {
    const current = parseClaimRecord(await Bun.file(path).text())
    if (JSON.stringify(current) !== JSON.stringify(record)) {
      throw new Error("Workflow claim record conflicts with an existing claim")
    }
    return
  }
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  await Bun.write(temporary, serialized)
  renameSync(temporary, path)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
