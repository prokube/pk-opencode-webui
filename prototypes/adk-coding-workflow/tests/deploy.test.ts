import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const manifest = readFileSync(new URL("../deploy/workflow-template.yaml", import.meta.url), "utf8")
const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8")
const makefile = readFileSync(new URL("../Makefile", import.meta.url), "utf8")
const supervisorManifest = readFileSync(new URL("../deploy/supervisor-workflow.yaml", import.meta.url), "utf8")
const autoManifest = readFileSync(new URL("../deploy/auto-workflow.yaml", import.meta.url), "utf8")
const executeManifest = manifest.split("---\n").at(-1) ?? ""
const validateTemplate = executeManifest.split("    - name: validate\n      inputs:").at(-1)?.split("    - name: attest\n")[0] ?? ""
const publishTemplate = executeManifest.split("    - name: publish\n      retryStrategy:").at(-1) ?? ""
const exitHandlerTemplate = executeManifest.split("    - name: exit-handler\n").at(-1)?.split("    - name: reconcile-claim\n")[0] ?? ""
const cleanupTemplate = executeManifest.split("    - name: reconcile-claim\n      retryStrategy:").at(-1)?.split("    - name: report\n")[0] ?? ""
const reportTemplate = executeManifest.split("    - name: report\n      automountServiceAccountToken:").at(-1) ?? ""

describe("execute workflow template", () => {
  test("accepts an explicit target and resolves validation through policy", () => {
    expect(executeManifest).toContain("- name: ticket-repository")
    expect(executeManifest).toContain("- name: target-repository")
    expect(executeManifest).not.toContain("- prokube/pkui")
    expect(executeManifest).toContain("- name: base\n        value: main")
    expect(executeManifest.match(/- --base/g)?.length).toBeGreaterThanOrEqual(3)
    expect(executeManifest.match(/- "{{inputs.parameters.base}}"/g)).toHaveLength(3)
    expect(executeManifest.match(/value: "{{inputs.parameters.base}}"/g)).toHaveLength(3)
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
    expect(executeManifest.match(/automountServiceAccountToken: false/g)).toHaveLength(10)
    expect(executeManifest).toContain("executor:\n    serviceAccountName: adk-coding-workflow")
  })

  test("uses one worker image and isolates validation from retained artifacts", () => {
    const images = [...executeManifest.matchAll(/image: (\S+)/g)].map((match) => match[1])
    expect(new Set(images)).toEqual(new Set([
      "europe-west3-docker.pkg.dev/prokube-internal/prokube-customer/adk-coding-workflow:prototype-cg-20260807-2225",
    ]))
    expect(validateTemplate).toContain("git clone --no-hardlinks")
    expect(validateTemplate).toContain("bun /app/src/validate.ts \\")
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
    expect(executeManifest.match(/name: GH_TOKEN/g)).toHaveLength(6)
    expect(executeManifest.match(/secretName: adk-coding-workflow-opencode-auth/g)).toHaveLength(1)
    expect(executeManifest).toContain('"model":"openai/gpt-5.6-sol"')
    expect(executeManifest).toContain("cp /opencode-auth/auth.json")
    expect(executeManifest).toContain("activeDeadlineSeconds: 86400")
    expect(executeManifest).toContain("name: runner-tmp")
    expect(executeManifest).toContain("value: /tmp")
    expect(validateTemplate).toContain('cpu: "4"')
    expect(validateTemplate).toContain("memory: 4Gi")
  })

  test("reports a safe result after success, failure, or blocking", () => {
    expect(executeManifest).toContain("onExit: exit-handler")
    expect(exitHandlerTemplate).toContain("name: workflow-result")
    expect(exitHandlerTemplate).toContain("{{steps.report.outputs.parameters.workflow-result}}")
    expect(exitHandlerTemplate).toContain("name: reconcile-claim")
    expect(exitHandlerTemplate).toContain("failed: true")
    expect(exitHandlerTemplate).toContain("error: true")
    expect(exitHandlerTemplate.indexOf("name: reconcile-claim")).toBeLessThan(exitHandlerTemplate.indexOf("name: report"))
    expect(cleanupTemplate).toContain("/app/src/cleanup.ts")
    expect(cleanupTemplate).toContain("name: GH_TOKEN")
    expect(cleanupTemplate).toContain("PK_WORKFLOW_CLAIM_FILE")
    expect(cleanupTemplate).toContain("PK_WORKFLOW_RESULT_FILE")
    expect(cleanupTemplate).not.toContain("adk-coding-workflow-opencode-auth")
    expect(reportTemplate).toContain("name: workflow-result")
    expect(reportTemplate).toContain("path: /tmp/workflow-result.json")
    expect(reportTemplate).toContain("/app/src/report.ts")
    expect(reportTemplate).toContain('value: "{{workflow.status}}"')
    expect(reportTemplate).toContain("readOnly: true")
    expect(reportTemplate).not.toContain("GH_TOKEN")
    expect(reportTemplate).not.toContain("adk-coding-workflow-opencode-auth")
  })

  test("submits publishing runs with explicit issue and base parameters", () => {
    expect(makefile).toContain("ISSUE ?=")
    expect(makefile).toContain("BASE ?= main")
    expect(makefile).toContain('test -n "$(ISSUE)"')
    expect(makefile).toContain('{"name": "base", "value": strenv(BASE)}')
  })

  test("discovers, suspends for human selection, revalidates, and executes the selected ticket", () => {
    expect(supervisorManifest).toContain("entrypoint: supervise")
    expect(supervisorManifest).toContain('- name: issue\n        value: "0"')
    expect(supervisorManifest).toContain("- name: ticket-repository\n        value: prokube/pkui")
    expect(supervisorManifest).toContain("- name: target-repository\n        value: prokube/pkui")
    expect(executeManifest).toContain("- name: supervise")
    expect(executeManifest).toContain("globalName: candidate-list")
    expect(executeManifest).toContain("- name: select-ticket")
    expect(executeManifest).toContain("suspend: {}")
    expect(executeManifest).toContain("- name: selected-ticket\n            valueFrom:\n              supplied: {}")
    expect(executeManifest).toContain("- name: base-branch\n            valueFrom:\n              supplied: {}")
    expect(executeManifest).toContain("- name: revalidate-selection")
    expect(executeManifest).toContain("- name: claim-selected-ticket")
    expect(executeManifest).toContain("/app/src/discovery-cli.ts")
    expect(executeManifest).toContain("value: \"{{steps.revalidate-selection.outputs.parameters.issue}}\"")
    expect(executeManifest).toContain("value: \"{{steps.revalidate-selection.outputs.parameters.base}}\"")
    expect(executeManifest).toContain("- name: publish\n                  value: \"true\"")
    expect(executeManifest.indexOf("        - - name: revalidate-selection"))
      .toBeLessThan(executeManifest.indexOf("        - - name: claim-selected-ticket"))
    expect(executeManifest.indexOf("        - - name: claim-selected-ticket"))
      .toBeLessThan(executeManifest.indexOf("        - - name: execute-selected-ticket"))
    const claimTemplate = executeManifest.split("    - name: claim-selected-ticket\n").at(-1)?.split("    - name: execute\n")[0] ?? ""
    expect(executeManifest).toContain("name: adk-coding-workflow-ticket-claim")
    expect(claimTemplate).toContain("- claim")
    expect(claimTemplate).toContain('value: "{{workflow.name}}"')
    expect(claimTemplate).toContain("PK_WORKFLOW_BOT_LOGIN")
    expect(claimTemplate).toContain("PK_WORKFLOW_CLAIM_FILE")
    expect(claimTemplate).toContain("mountPath: /workspace")
    expect(claimTemplate).not.toContain("adk-coding-workflow-opencode-auth")
  })

  test("keeps an automatic first-candidate variant beside manual selection", () => {
    expect(autoManifest).toContain("entrypoint: auto-supervise")
    expect(autoManifest).toContain('"includeLabels":["ready"]')
    expect(autoManifest).toContain('"excludeLabels":["in-progress","needs-discussion","needs-supervisor"]')
    expect(executeManifest).toContain("- name: auto-supervise")
    expect(executeManifest).toContain("- name: select-first-ticket")
    expect(executeManifest).toContain("- select-first")
    expect(executeManifest.indexOf("        - - name: select-first-ticket"))
      .toBeLessThan(executeManifest.indexOf("        - - name: revalidate-selection", executeManifest.indexOf("- name: auto-supervise")))
    expect(makefile).toContain("auto:")
    expect(makefile).toContain("deploy/auto-workflow.yaml")
  })

  test("keeps discovery credentials out of model, validation, attestation, and reports", () => {
    const discoverTemplate = executeManifest.split("    - name: discover\n      inputs:").at(-1)?.split("    - name: select-ticket")[0] ?? ""
    const revalidateTemplate = executeManifest.split("    - name: revalidate-selection\n      inputs:").at(-1)?.split("    - name: execute\n")[0] ?? ""
    expect(discoverTemplate).toContain("name: GH_TOKEN")
    expect(discoverTemplate).not.toContain("adk-coding-workflow-opencode-auth")
    expect(revalidateTemplate).toContain("name: GH_TOKEN")
    expect(revalidateTemplate).not.toContain("adk-coding-workflow-opencode-auth")
    expect(validateTemplate).not.toContain("GH_TOKEN")
    expect(reportTemplate).not.toContain("GH_TOKEN")
  })
})
