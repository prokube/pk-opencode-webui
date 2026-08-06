import { describe, expect, test } from "bun:test"

import { parseArgs } from "../src/cli"

describe("CLI", () => {
  test("defaults to non-mutating plan mode", () => {
    const options = parseArgs([
      "--ticket-repository", "prokube/pkui",
      "--target-repository", "prokube/pkui",
      "--issue", "42",
    ])
    expect(options.mode).toBe("plan")
    expect(options.baseBranch).toBe("main")
    expect(options.codingRequest.targets).toEqual([{ repository: "prokube/pkui", baseBranch: undefined }])
  })

  test("resolves deterministic validation from the repository policy", () => {
    const options = parseArgs([
      "--ticket-repository", "prokube/pkui",
      "--target-repository", "prokube/pkui",
      "--issue", "42",
      "--mode", "execute",
    ])
    expect(options.validationCommands).toContain("cd frontend && npm run typecheck")
    expect(options.validationCommands).toContain("cd backend-main && uv run pytest tests/ -q")
  })

  test("rejects invalid modes and issue numbers", () => {
    expect(() => parseArgs([
      "--ticket-repository", "prokube/pkui", "--target-repository", "prokube/pkui", "--issue", "0",
    ])).toThrow("positive integer")
    expect(() => parseArgs([
      "--ticket-repository", "prokube/pkui", "--target-repository", "prokube/pkui",
      "--issue", "42", "--mode", "merge",
    ])).toThrow("Invalid --mode")
  })

  test("rejects requests without an explicit target", () => {
    expect(() => parseArgs([
      "--ticket-repository", "prokube/pkui",
      "--issue", "42",
      "--mode", "publish",
      "--bot-login", "prokube-bot",
    ])).toThrow("exactly one target repository")
  })
})
