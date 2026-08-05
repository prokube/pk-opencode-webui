import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const manifest = readFileSync(new URL("../deploy/workflow-template.yaml", import.meta.url), "utf8")
const executeManifest = manifest.split("---\n").at(-1) ?? ""
const validateTemplate = executeManifest.split("    - name: validate").at(-1) ?? ""

describe("execute workflow template", () => {
  test("pins the repository, base branch, and validation entry points", () => {
    expect(executeManifest).toContain("- prokube/pkui")
    expect(executeManifest).toContain("- --base\n          - main")
    expect(executeManifest).not.toContain("- name: base")
    expect(executeManifest).toContain("npm ci --ignore-scripts")
    expect(executeManifest).toContain("./node_modules/.bin/tsc --noEmit")
    expect(executeManifest).toContain("./node_modules/.bin/vitest run")
    expect(executeManifest).not.toContain("npm run typecheck")
    expect(executeManifest).not.toContain("npm test")
  })

  test("does not mount Kubernetes service-account tokens in code execution pods", () => {
    expect(manifest).toContain("name: adk-coding-workflow.service-account-token")
    expect(manifest).toContain("kubernetes.io/service-account.name: adk-coding-workflow")
    expect(executeManifest.match(/automountServiceAccountToken: false/g)).toHaveLength(2)
    expect(executeManifest).toContain("executor:\n    serviceAccountName: adk-coding-workflow")
  })

  test("uses one worker image and isolates validation from retained artifacts", () => {
    const images = [...executeManifest.matchAll(/image: (\S+)/g)].map((match) => match[1])
    expect(new Set(images)).toEqual(new Set([
      "europe-west3-docker.pkg.dev/prokube-internal/prokube-customer/adk-coding-workflow:prototype-cg-20260805-122114",
    ]))
    expect(validateTemplate).toContain("cp -a /workspace/.data/workspaces/{{workflow.name}}/worktree /validation/worktree")
    expect(validateTemplate).toContain("mountPath: /workspace")
    expect(validateTemplate).toContain("readOnly: true")
  })
})
