import { validateRepository } from "./domain"

export type RepositoryPolicy = {
  repository: string
  baseBranch: string
  allowedPathPrefixes: string[]
  setupCommands: string[]
  validationCommands: string[]
}

const policies: Record<string, RepositoryPolicy> = {
  "prokube/pkui": {
    repository: "prokube/pkui",
    baseBranch: "main",
    allowedPathPrefixes: [
      "backend-agent/src/",
      "backend-agent/tests/",
      "backend-kubeconfig/src/",
      "backend-kubeconfig/tests/",
      "backend-main/src/",
      "backend-main/tests/",
      "docs/",
      "frontend/src/",
      "k8s/helm/pk-ui/",
      "tests/",
    ],
    setupCommands: [],
    validationCommands: [
      "make test-unit",
    ],
  },
}

export function repositoryPolicy(repository: string): RepositoryPolicy {
  const normalized = validateRepository(repository)
  const policy = policies[normalized]
  if (!policy) throw new Error(`Repository is not allowlisted: ${normalized}`)
  return policy
}

export function repositoryCommands(repository: string): string[] {
  const policy = repositoryPolicy(repository)
  return [...policy.setupCommands, ...policy.validationCommands]
}

export function assertPolicyPaths(repository: string, changedFiles: string[]): void {
  const policy = repositoryPolicy(repository)
  const disallowed = changedFiles.filter(
    (path) => !policy.allowedPathPrefixes.some((prefix) => path.startsWith(prefix)),
  )
  if (disallowed.length) {
    throw new Error(`Changed files are outside the approved repository policy: ${disallowed.join(", ")}`)
  }
}
