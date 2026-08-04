import { describe, expect, test } from "bun:test"

import { parseArgs } from "../src/cli"

describe("CLI", () => {
  test("defaults to non-mutating plan mode", () => {
    const options = parseArgs(["--repository", "prokube/pkui", "--issue", "42"])
    expect(options.mode).toBe("plan")
    expect(options.baseBranch).toBe("main")
  })

  test("supports repeated deterministic validation commands", () => {
    const options = parseArgs([
      "--repository", "prokube/pkui",
      "--issue", "42",
      "--mode", "execute",
      "--validate", "bun test",
      "--validate", "bun run typecheck",
    ])
    expect(options.validationCommands).toEqual(["bun test", "bun run typecheck"])
  })

  test("rejects invalid modes and issue numbers", () => {
    expect(() => parseArgs(["--repository", "prokube/pkui", "--issue", "0"])).toThrow("positive integer")
    expect(() => parseArgs([
      "--repository", "prokube/pkui", "--issue", "42", "--mode", "merge",
    ])).toThrow("Invalid --mode")
  })

  test("requires deterministic validation before publish", () => {
    expect(() => parseArgs([
      "--repository", "prokube/pkui",
      "--issue", "42",
      "--mode", "publish",
      "--bot-login", "prokube-bot",
    ])).toThrow("requires at least one --validate")
  })
})
