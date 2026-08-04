import { Database } from "bun:sqlite"
import { dirname } from "node:path"
import { mkdirSync } from "node:fs"

import type { RunMode, RunPhase, RunRecord, WorkflowResult } from "./domain"

export class ActiveRunError extends Error {}

export class RunStore {
  private readonly db: Database

  constructor(
    path: string,
    private readonly leaseTtlMs = 2 * 60 * 60_000,
  ) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path, { create: true })
    this.db.exec("PRAGMA journal_mode = WAL")
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        run_key TEXT NOT NULL,
        repository TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        mode TEXT NOT NULL,
        phase TEXT NOT NULL,
        summary TEXT NOT NULL,
        branch TEXT,
        workspace TEXT,
        session_id TEXT,
        pull_request_url TEXT,
        changed_files TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS leases (
        run_key TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
    `)
    const columns = this.db.query("PRAGMA table_info(leases)").all() as Array<{ name: string }>
    if (!columns.some((column) => column.name === "expires_at")) {
      this.db.exec("ALTER TABLE leases ADD COLUMN expires_at TEXT")
      this.db.query("UPDATE leases SET expires_at = created_at WHERE expires_at IS NULL").run()
    }
  }

  createRun(input: {
    runKey: string
    repository: string
    issueNumber: number
    mode: RunMode
  }): RunRecord {
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    const expiresAt = new Date(Date.now() + this.leaseTtlMs).toISOString()
    const transaction = this.db.transaction(() => {
      this.db.query("DELETE FROM leases WHERE expires_at <= ?").run(now)
      try {
        this.db.query("INSERT INTO leases (run_key, run_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
          .run(input.runKey, id, now, expiresAt)
      } catch (error) {
        if (String(error).includes("UNIQUE constraint failed")) {
          throw new ActiveRunError(`An active run already holds ${input.runKey}`)
        }
        throw error
      }
      this.db.query(`
        INSERT INTO runs (
          id, run_key, repository, issue_number, mode, phase, summary,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'created', 'Run created', ?, ?)
      `).run(id, input.runKey, input.repository, input.issueNumber, input.mode, now, now)
    })
    transaction()
    return this.getRun(id)
  }

  updateRun(runId: string, result: Omit<WorkflowResult, "runId">): RunRecord {
    const now = new Date().toISOString()
    this.db.query(`
      UPDATE runs SET
        phase = ?, summary = ?, branch = COALESCE(?, branch),
        workspace = COALESCE(?, workspace), session_id = COALESCE(?, session_id),
        pull_request_url = COALESCE(?, pull_request_url),
        changed_files = COALESCE(?, changed_files), updated_at = ?
      WHERE id = ?
    `).run(
      result.phase,
      result.summary,
      result.branch ?? null,
      result.workspace ?? null,
      result.sessionId ?? null,
      result.pullRequestUrl ?? null,
      result.changedFiles ? JSON.stringify(result.changedFiles) : null,
      now,
      runId,
    )
    return this.getRun(runId)
  }

  release(runId: string): void {
    this.db.query("DELETE FROM leases WHERE run_id = ?").run(runId)
  }

  heartbeat(runId: string): void {
    const expiresAt = new Date(Date.now() + this.leaseTtlMs).toISOString()
    this.db.query("UPDATE leases SET expires_at = ? WHERE run_id = ?").run(expiresAt, runId)
  }

  getRun(runId: string): RunRecord {
    const row = this.db.query("SELECT * FROM runs WHERE id = ?").get(runId) as Record<string, unknown> | null
    if (!row) throw new Error(`Unknown run: ${runId}`)
    return {
      runId: String(row.id),
      repository: String(row.repository),
      issueNumber: Number(row.issue_number),
      mode: String(row.mode) as RunMode,
      phase: String(row.phase) as RunPhase,
      summary: String(row.summary),
      branch: row.branch ? String(row.branch) : undefined,
      workspace: row.workspace ? String(row.workspace) : undefined,
      sessionId: row.session_id ? String(row.session_id) : undefined,
      pullRequestUrl: row.pull_request_url ? String(row.pull_request_url) : undefined,
      changedFiles: row.changed_files ? JSON.parse(String(row.changed_files)) as string[] : undefined,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }
  }

  close(): void {
    this.db.close()
  }
}
