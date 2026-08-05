import { describe, expect, test } from "bun:test"

import { BunProcessRunner, requireSuccess, type ProcessRunner } from "../src/process"

describe("BunProcessRunner", () => {
  test("terminates commands that exceed their timeout", async () => {
    const runner = new BunProcessRunner()
    await expect(runner.run(["bash", "-c", "sleep 5"], { timeoutMs: 10 }))
      .rejects.toThrow("Command timed out")
  })

  test("retains the end of long command errors", async () => {
    const runner: ProcessRunner = {
      async run() {
        return { exitCode: 2, stdout: "", stderr: `${"warning\n".repeat(300)}final diagnostic` }
      },
    }
    await expect(requireSuccess(runner, ["npm", "run", "typecheck"]))
      .rejects.toThrow("final diagnostic")
  })
})
