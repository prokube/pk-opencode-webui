# ADK Coding Workflow Prototype

This prototype validates the deterministic issue-to-pull-request flow described
in [`docs/AUTONOMOUS_CODING_WORKFLOWS.md`](../../docs/AUTONOMOUS_CODING_WORKFLOWS.md).
It uses the TypeScript Google Agent Development Kit to run a custom workflow
agent around deterministic GitHub, Git, OpenCode, validation, and publishing
services.

It is safe by default: the CLI starts in `plan` mode and does not mutate GitHub
or clone a repository unless a more permissive mode is explicitly selected.

## Implemented Scope

- Fetch an issue, comments, labels, assignees, and native blockers from GitHub.
- Accept only open, unassigned `ready` issues without `in-progress`,
  `needs-discussion`, or open blockers.
- Store local run history and active issue leases in SQLite.
- Clone through an environment-backed Git credential helper without putting the
  token in command arguments or the remote URL.
- Create an isolated Git worktree and `feature/issue-N` branch.
- Create and monitor an OpenCode session through the HTTP API.
- Deny OpenCode shell, network-fetch, and external-directory tools; repository
  validation runs only in a separate deterministic step.
- Stop when OpenCode asks a question or requests an unsupported permission.
- Run explicit validation commands without GitHub token environment variables.
- Refuse to publish common credential and private-key paths.
- Commit, push, and create a normal unmerged pull request in `publish` mode.
- Generate stable issue and review-remediation correlation keys.

## Modes

| Mode | GitHub mutation | Repository changes | OpenCode | Pull request |
| --- | --- | --- | --- | --- |
| `plan` | No | No | No | No |
| `execute` | No | Local isolated workspace | Yes | No |
| `publish` | Claim/comment | Isolated workspace and remote branch | Yes | Yes |

## Install

```bash
cd prototypes/adk-coding-workflow
bun install
```

## Start OpenCode

Run OpenCode as a separate process without GitHub credentials. Configure its
model/provider normally before starting it.

```bash
env -u GH_TOKEN -u GITHUB_TOKEN -u GITHUB_PAT \
  opencode serve --hostname 127.0.0.1 --port 4096
```

The prototype grants the OpenCode session repository read/search/edit tools but
denies shell, network-fetch, and external-directory tools. This is application
policy, not a container security boundary; use only trusted repositories until
the worker runs in a sandboxed container.

## Plan An Issue

Public repositories may not require a token for read-only planning. Private
repositories require a fine-grained token with issue read access.

```bash
GH_TOKEN=<bot-token> bun run src/cli.ts \
  --repository prokube/pkui \
  --issue 3523
```

`plan` is the default mode. It validates eligibility and writes only the local
SQLite run record under `.data/`.

## Execute Without Publishing

```bash
GH_TOKEN=<bot-token> bun run src/cli.ts \
  --repository prokube/pkui \
  --issue 3523 \
  --mode execute \
  --validate "make test-unit"
```

The result includes the retained worktree and OpenCode session ID for manual
inspection. It does not claim the issue, push a branch, or create a pull
request.

## Publish A Pull Request

`publish` performs real GitHub mutations. Use a dedicated bot with a
fine-grained PAT restricted to the selected repository and Issues, Contents,
and Pull requests read/write access.

```bash
GH_TOKEN=<bot-token> bun run src/cli.ts \
  --repository prokube/pkui \
  --issue 3523 \
  --mode publish \
  --bot-login <bot-login> \
  --validate "make test-unit"
```

The mode removes `ready`, adds `in-progress`, assigns the bot, pushes
`feature/issue-N`, and creates a normal unmerged pull request containing
`Closes #N`. Publish mode requires at least one `--validate` command and refuses
to continue when an open pull request or remote issue branch already exists.

## Other Options

```text
--base <branch>             Base branch, default: main
--workspace-root <path>     Run workspaces, default: .data/workspaces
--database <path>           SQLite database, default: .data/coding-workflow.sqlite
--opencode-url <url>        OpenCode server, default: http://127.0.0.1:4096
--validate <command>        Repeatable validation command
```

## Test

```bash
bun test
bun run typecheck
```

The unit suite uses fake GitHub, OpenCode, and process boundaries. It does not
contact GitHub, clone repositories, start OpenCode, or create pull requests.

## Prototype Limitations

- There is no webhook server, periodic ready-issue reconciler, or review-event
  processing yet.
- SQLite leases protect only processes sharing the same database file. Active
  runs heartbeat locally; stale leases expire two hours after their last update.
- ADK sessions are in memory; durable domain run records are in SQLite.
- The OpenCode server and repository commands run on the local machine rather
  than in gVisor, `pk-sandbox`, or an Argo Workflow.
- OpenCode tool permissions and removed GitHub token variables do not constitute
  production process or filesystem isolation.
- The publisher rejects pre-staged files, local HEAD changes, existing pull
  requests, and existing remote branches, but does not recover GitHub labels
  after every partial failure.
- There is no automatic cleanup or retention controller for worktrees.
- Validation commands are operator-provided shell commands and must be reviewed.
- Repository and validation commands have a 30-minute hard timeout, which is a
  prototype-wide default rather than a command-specific resource policy.
- Review-remediation correlation keys exist, but remediation workflows are not
  implemented.

The ADK dependency currently needs explicit transitive security overrides in
`package.json`. `bun audit` must remain clean before this prototype is built into
an image; remove the overrides when upstream dependency ranges include the fixed
versions directly.

These limitations are deliberate. The next useful increment is a single
containerized `execute` run in gVisor, followed by webhook/lease reconciliation
and review-remediation support.
