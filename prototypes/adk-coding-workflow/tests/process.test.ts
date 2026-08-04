import { describe, expect, test } from "bun:test"

import { BunProcessRunner } from "../src/process"

describe("BunProcessRunner", () => {
  test("terminates commands that exceed their timeout", async () => {
    const runner = new BunProcessRunner()
    await expect(runner.run(["bash", "-c", "sleep 5"], { timeoutMs: 10 }))
      .rejects.toThrow("Command timed out")
  })
})
