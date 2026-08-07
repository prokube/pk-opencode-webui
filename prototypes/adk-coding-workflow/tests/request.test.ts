import { describe, expect, test } from "bun:test"

import { assertPolicyPaths, repositoryCommands, repositoryPolicy } from "../src/policy"
import { workflowRequest } from "../src/request"

const request = {
  ticket: { provider: "github" as const, repository: "prokube/pkui", number: 42 },
  targets: [{ repository: "prokube/pkui" }],
  publish: true,
}

describe("coding request", () => {
  test("resolves one allowlisted target through its reviewed policy", () => {
    const resolved = workflowRequest({ request, mode: "execute", workspaceRoot: "/workspace" })

    expect(resolved).toMatchObject({
      repository: "prokube/pkui",
      issueNumber: 42,
      baseBranch: "main",
    })
    expect(resolved.validationCommands).toEqual(repositoryCommands("prokube/pkui"))
    expect(repositoryPolicy("prokube/pkui").validationCommands).toEqual(["make test-unit"])
  })

  test("rejects unsupported repositories and multi-target requests in M1", () => {
    expect(() => workflowRequest({
      request: { ...request, targets: [{ repository: "unknown/repository" }] },
      mode: "execute",
      workspaceRoot: "/workspace",
    })).toThrow("ticket and target repository to match")
    expect(() => workflowRequest({
      request: { ...request, targets: [...request.targets, { repository: "prokube/pkui" }] },
      mode: "execute",
      workspaceRoot: "/workspace",
    })).toThrow("exactly one target repository")
  })

  test("rejects a target repository without an approved policy", () => {
    expect(() => repositoryPolicy("unknown/repository")).toThrow("not allowlisted")
  })

  test("allows reviewed product paths and rejects repository control files", () => {
    expect(() => assertPolicyPaths(
      "prokube/pkui",
      [
        "backend-main/src/pk_ui_backend/modules/marathon/routes.py",
        "backend-main/tests/test_marathon.py",
        "frontend/src/modules/llm/components/DeployLlmModal.tsx",
        "k8s/helm/pk-ui/files/marathon-presets.yaml",
      ],
    )).not.toThrow()
    expect(() => assertPolicyPaths(
      "prokube/pkui",
      ["docs/INSTALLATION.md", "tests/e2e/test_capabilities.py"],
    )).not.toThrow()
    expect(() => assertPolicyPaths("prokube/pkui", ["frontend/package.json"])).toThrow(
      "outside the approved repository policy",
    )
    expect(() => assertPolicyPaths("prokube/pkui", [".github/workflows/ci.yml"])).toThrow(
      "outside the approved repository policy",
    )
  })
})
