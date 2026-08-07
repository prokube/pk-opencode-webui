import { describe, expect, test } from "bun:test"

import { parseArgs } from "../src/cli"
import { parseDiscoveryArgs } from "../src/discovery-cli"

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
    expect(options.validationCommands).toEqual(["make test-unit"])
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

describe("discovery CLI", () => {
  test("requires explicit discovery and revalidation inputs", () => {
    expect(parseDiscoveryArgs([
      "--mode", "discover",
      "--request", '{"projects":[]}',
      "--output-dir", "/tmp/outputs",
    ])).toEqual({ mode: "discover", request: '{"projects":[]}', outputDir: "/tmp/outputs" })
    expect(() => parseDiscoveryArgs([
      "--mode", "revalidate",
      "--request", '{"projects":[]}',
      "--candidates", '{"candidates":[],"truncated":false}',
      "--output-dir", "/tmp/outputs",
    ])).toThrow("--selected-ticket")
  })

  test("parses the mutation-only claim mode without an output directory", () => {
    expect(parseDiscoveryArgs([
      "--mode", "claim",
      "--request", '{"projects":[]}',
      "--selected-ticket", '{"provider":"github","project":"prokube/pkui","number":42}',
    ])).toEqual({
      mode: "claim",
      request: '{"projects":[]}',
      selectedTicket: '{"provider":"github","project":"prokube/pkui","number":42}',
    })
  })
})
