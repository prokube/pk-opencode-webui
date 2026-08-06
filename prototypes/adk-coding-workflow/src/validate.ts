import { resolve } from "node:path"

import { assertPolicyPaths, repositoryCommands } from "./policy"
import { BunProcessRunner } from "./process"
import { WorkspaceService } from "./workspace"

export async function main(argv = Bun.argv.slice(2)): Promise<void> {
  const repositoryIndex = argv.indexOf("--repository")
  const worktreeIndex = argv.indexOf("--worktree")
  const repository = repositoryIndex >= 0 ? argv[repositoryIndex + 1] : undefined
  const worktree = worktreeIndex >= 0 ? argv[worktreeIndex + 1] : undefined
  if (!repository) throw new Error("Missing required option --repository")
  if (!worktree) throw new Error("Missing required option --worktree")
  const resolvedWorktree = resolve(worktree)
  const workspace = new WorkspaceService(new BunProcessRunner())
  assertPolicyPaths(repository, await workspace.changedFiles(resolvedWorktree))
  await workspace.validate(resolvedWorktree, repositoryCommands(repository))
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
