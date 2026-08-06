import { validateRepository } from "./domain"

export type RepositoryPolicy = {
  repository: string
  baseBranch: string
  setupCommands: string[]
  validationCommands: string[]
}

const policies: Record<string, RepositoryPolicy> = {
  "prokube/pkui": {
    repository: "prokube/pkui",
    baseBranch: "main",
    setupCommands: [
      "cd frontend && npm ci --ignore-scripts",
      "cd backend-main && uv sync --frozen --group dev",
      "cd backend-kubeconfig && uv sync --frozen --group dev",
    ],
    validationCommands: [
      "git diff --exit-code HEAD -- frontend/package.json frontend/package-lock.json",
      "cd frontend && npm run typecheck",
      // A cold gVisor run can lose Vitest workers; one bounded retry still leaves stable failures red.
      "cd frontend && npm test -- --maxWorkers=2 || npm test -- --maxWorkers=2",
      "cd backend-main && uv run pytest tests/ -q",
      "cd backend-kubeconfig && uv run pytest tests/ -q",
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
