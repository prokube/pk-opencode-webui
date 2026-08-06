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
    expect(repositoryPolicy("prokube/pkui").validationCommands).toContain(
      "cd frontend && npm run typecheck",
    )
    expect(repositoryPolicy("prokube/pkui").validationCommands).toContain(
      "cd frontend && npm test -- src/modules/user-management --maxWorkers=2",
    )
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

  test("limits the M1 policy to frontend changes", () => {
    expect(() => assertPolicyPaths(
      "prokube/pkui",
      ["frontend/src/modules/user-management/components/CreateUserModal.tsx"],
    )).not.toThrow()
    expect(() => assertPolicyPaths("prokube/pkui", ["frontend/src/App.tsx"])).toThrow(
      "outside the approved M1 policy",
    )
    expect(() => assertPolicyPaths("prokube/pkui", ["backend-main/src/main.py"])).toThrow(
      "outside the approved M1 policy",
    )
  })
})
