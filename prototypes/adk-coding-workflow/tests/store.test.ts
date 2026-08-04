import { describe, expect, test } from "bun:test"

import { ActiveRunError, RunStore } from "../src/store"

describe("RunStore", () => {
  test("persists phase updates and prevents concurrent leases", () => {
    const store = new RunStore(":memory:")
    const first = store.createRun({
      runKey: "prokube/pkui#42",
      repository: "prokube/pkui",
      issueNumber: 42,
      mode: "execute",
    })
    expect(() => store.createRun({
      runKey: "prokube/pkui#42",
      repository: "prokube/pkui",
      issueNumber: 42,
      mode: "execute",
    })).toThrow(ActiveRunError)

    store.updateRun(first.runId, {
      phase: "prepared",
      summary: "Prepared",
      workspace: "/tmp/worktree",
      changedFiles: ["src/example.ts"],
    })
    expect(store.getRun(first.runId)).toMatchObject({
      phase: "prepared",
      workspace: "/tmp/worktree",
      changedFiles: ["src/example.ts"],
    })

    store.release(first.runId)
    expect(() => store.createRun({
      runKey: "prokube/pkui#42",
      repository: "prokube/pkui",
      issueNumber: 42,
      mode: "execute",
    })).not.toThrow()
    store.close()
  })

  test("reclaims expired leases after a crashed process", () => {
    const store = new RunStore(":memory:", -1)
    store.createRun({
      runKey: "prokube/pkui#99",
      repository: "prokube/pkui",
      issueNumber: 99,
      mode: "execute",
    })
    expect(() => store.createRun({
      runKey: "prokube/pkui#99",
      repository: "prokube/pkui",
      issueNumber: 99,
      mode: "execute",
    })).not.toThrow()
    store.close()
  })
})
