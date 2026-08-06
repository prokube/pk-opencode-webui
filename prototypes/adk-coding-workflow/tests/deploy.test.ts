import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const manifest = readFileSync(new URL("../deploy/workflow-template.yaml", import.meta.url), "utf8")
const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8")
const executeManifest = manifest.split("---\n").at(-1) ?? ""
const validateTemplate = executeManifest.split("    - name: validate\n      inputs:").at(-1) ?? ""
const publishTemplate = executeManifest.split("    - name: publish\n      retryStrategy:").at(-1) ?? ""
const reportTemplate = executeManifest.split("    - name: report\n      automountServiceAccountToken:").at(-1) ?? ""

describe("execute workflow template", () => {
  test("accepts an explicit target and resolves validation through policy", () => {
    expect(executeManifest).toContain("- name: ticket-repository")
    expect(executeManifest).toContain("- name: target-repository")
    expect(executeManifest).not.toContain("- prokube/pkui")
    expect(executeManifest).not.toContain("- name: base")
    expect(executeManifest).toContain("- --mode\n          - execute")
    expect(executeManifest).not.toContain("- --mode\n          - implement")
    expect(validateTemplate).toContain("bun /app/src/validate.ts")
    expect(validateTemplate).toContain('--repository "{{inputs.parameters.target-repository}}"')
    expect(executeManifest).not.toContain("KeyCreationModals.test.tsx")
  })

  test("includes the repository toolchain needed by all unit-test suites", () => {
    expect(dockerfile).toContain("node:22.22-bookworm-slim")
    expect(dockerfile).toContain('"uv==${UV_VERSION}"')
    expect(dockerfile).toContain("/usr/local/bin/helm")
    expect(dockerfile).toContain("/usr/local/bin/kubectl")
  })

  test("does not mount Kubernetes service-account tokens in code execution pods", () => {
    expect(manifest).toContain("name: adk-coding-workflow.service-account-token")
    expect(manifest).toContain("kubernetes.io/service-account.name: adk-coding-workflow")
    expect(executeManifest.match(/automountServiceAccountToken: false/g)).toHaveLength(5)
    expect(executeManifest).toContain("executor:\n    serviceAccountName: adk-coding-workflow")
  })

  test("uses one worker image and isolates validation from retained artifacts", () => {
    const images = [...executeManifest.matchAll(/image: (\S+)/g)].map((match) => match[1])
    expect(new Set(images)).toEqual(new Set([
      "europe-west3-docker.pkg.dev/prokube-internal/prokube-customer/adk-coding-workflow:prototype-cg-20260806-1743",
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
    expect(publishTemplate).not.toContain("adk-coding-workflow-opencode-auth")
    expect(executeManifest.match(/name: GH_TOKEN/g)).toHaveLength(2)
    expect(executeManifest.match(/secretName: adk-coding-workflow-opencode-auth/g)).toHaveLength(1)
    expect(executeManifest).toContain('"model":"openai/gpt-5.6-sol"')
    expect(executeManifest).toContain("cp /opencode-auth/auth.json")
    expect(executeManifest).toContain("activeDeadlineSeconds: 10800")
    expect(validateTemplate).toContain('cpu: "4"')
    expect(validateTemplate).toContain("memory: 4Gi")
  })

  test("reports a safe result after success, failure, or blocking", () => {
    expect(executeManifest).toContain("onExit: report")
    expect(reportTemplate).toContain("name: workflow-result")
    expect(reportTemplate).toContain("path: /tmp/workflow-result.json")
    expect(reportTemplate).toContain("/app/src/report.ts")
    expect(reportTemplate).toContain('value: "{{workflow.status}}"')
    expect(reportTemplate).toContain("readOnly: true")
    expect(reportTemplate).not.toContain("GH_TOKEN")
    expect(reportTemplate).not.toContain("adk-coding-workflow-opencode-auth")
  })
})
