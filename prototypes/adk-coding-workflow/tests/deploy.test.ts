import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const manifest = readFileSync(new URL("../deploy/workflow-template.yaml", import.meta.url), "utf8")
const executeManifest = manifest.split("---\n").at(-1) ?? ""
const validateTemplate = executeManifest.split("    - name: validate\n      automountServiceAccountToken:").at(-1) ?? ""
const publishTemplate = executeManifest.split("    - name: publish\n      retryStrategy:").at(-1) ?? ""

describe("execute workflow template", () => {
  test("pins the repository, base branch, and validation entry points", () => {
    expect(executeManifest).toContain("- prokube/pkui")
    expect(executeManifest).toContain("- --base\n          - main")
    expect(executeManifest).not.toContain("- name: base")
    expect(executeManifest).toContain("- --mode\n          - execute")
    expect(executeManifest).not.toContain("- --mode\n          - implement")
    expect(executeManifest).toContain("npm ci --ignore-scripts")
    expect(executeManifest.match(/npm run typecheck/g)).toHaveLength(2)
    expect(executeManifest.match(/npm test/g)).toHaveLength(2)
    expect(executeManifest).not.toContain("KeyCreationModals.test.tsx")
  })

  test("does not mount Kubernetes service-account tokens in code execution pods", () => {
    expect(manifest).toContain("name: adk-coding-workflow.service-account-token")
    expect(manifest).toContain("kubernetes.io/service-account.name: adk-coding-workflow")
    expect(executeManifest.match(/automountServiceAccountToken: false/g)).toHaveLength(4)
    expect(executeManifest).toContain("executor:\n    serviceAccountName: adk-coding-workflow")
  })

  test("uses one worker image and isolates validation from retained artifacts", () => {
    const images = [...executeManifest.matchAll(/image: (\S+)/g)].map((match) => match[1])
    expect(new Set(images)).toEqual(new Set([
      "europe-west3-docker.pkg.dev/prokube-internal/prokube-customer/adk-coding-workflow:prototype-cg-20260806-1224",
    ]))
    expect(validateTemplate).toContain("git clone --no-hardlinks")
    expect(validateTemplate).toContain("git -C /validation/worktree apply --binary /workspace/.workflow-output/changes.patch")
    expect(validateTemplate).toContain("mountPath: /workspace")
    expect(validateTemplate).toContain("readOnly: true")
  })

  test("publishes only after validation without exposing the model credential", () => {
    expect(executeManifest).toContain("template: attest")
    expect(executeManifest).toContain("- attest")
    expect(validateTemplate).toContain("path: /var/run/argo/outputs/patch.sha256")
    expect(validateTemplate).toContain("sha256sum /workspace/.workflow-output/changes.patch")
    expect(executeManifest).toContain("{{steps.validate.outputs.parameters.patch-sha256}}")
    expect(executeManifest).toContain("when: \"{{inputs.parameters.publish}} == true\"")
    expect(executeManifest).toContain("retryPolicy: Always")
    expect(publishTemplate).toContain("- finalize")
    expect(publishTemplate).toContain("name: GH_TOKEN")
    expect(publishTemplate).not.toContain("OPENAI_API_KEY")
    expect(executeManifest.match(/name: GH_TOKEN/g)).toHaveLength(2)
    expect(executeManifest.match(/name: OPENAI_API_KEY/g)).toHaveLength(1)
  })
})
