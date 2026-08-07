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
- Track publish state through GitHub labels, assignment, comments, branches, and
  pull requests.
- Clone through an environment-backed Git credential helper without putting the
  token in command arguments or the remote URL.
- Create an isolated Git worktree and `feature/issue-N` branch.
- Create and monitor an OpenCode session through the HTTP API.
- Deny OpenCode shell, network-fetch, and external-directory tools; repository
  validation runs only in a separate deterministic step.
- Stop when OpenCode asks a question or requests an unsupported permission.
- Run explicit validation commands without GitHub token environment variables.
- Validate the clean base before editing, then run the reviewed M1 frontend
  typecheck and complete user-management unit suite for every proposed change.
- Continue up to three validation repairs in the original OpenCode session so
  the agent retains issue and implementation context.
- Refuse to publish common credential and private-key paths.
- Commit, push, and create a normal unmerged pull request in `publish` mode.
- Generate stable review-remediation correlation keys.
- Discover and rank eligible tickets across configured GitHub repositories.
- Either suspend for an explicit human selection or automatically process the
  first ranked ticket while preserving the same revalidation and claim guards.

## Modes

| Mode | GitHub mutation | Repository changes | OpenCode | Pull request |
| --- | --- | --- | --- | --- |
| `plan` | No | No | No | No |
| `implement` | No | Shared workflow workspace | Yes | No |
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
  --ticket-repository prokube/pkui \
  --target-repository prokube/pkui \
  --issue 3523
```

`plan` is the default mode. It validates eligibility without writing local or
GitHub state.

## Execute Without Publishing

```bash
GH_TOKEN=<bot-token> bun run src/cli.ts \
  --ticket-repository prokube/pkui \
  --target-repository prokube/pkui \
  --issue 3523 \
  --mode execute
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
  --ticket-repository prokube/pkui \
  --target-repository prokube/pkui \
  --issue 3523 \
  --mode publish \
  --bot-login <bot-login>
```

The mode removes `ready`, adds `in-progress`, assigns the bot, pushes
`feature/issue-N`, and creates a normal unmerged pull request containing
`Closes #N`. Validation is resolved from the target repository's reviewed
allowlist policy. Publish mode refuses to continue when an open pull request or
remote issue branch already exists.

## Other Options

```text
--base <branch>             Base branch, default: main
--workspace-root <path>     Run workspaces, default: .data/workspaces
--opencode-url <url>        OpenCode server, default: http://127.0.0.1:4096
```

## Test

```bash
bun test
bun run typecheck
```

The unit suite uses fake GitHub, OpenCode, and process boundaries. It does not
contact GitHub, clone repositories, start OpenCode, or create pull requests.

## Deploy The Workers

The prototype includes pinned Argo `WorkflowTemplate` resources for read-only
`plan`, non-publishing `execute`, and opt-in publishing runs. All use gVisor and
a dedicated service account with only the Argo executor permissions required in
the namespace.

```bash
make build
make push
make deploy KUBECONFIG=~/.kube/solid-crocodile.yaml NAMESPACE=demo
```

Private repositories require a Secret named `adk-coding-workflow-github` with a
`token` key. Execute-only runs need read access; publishing requires a dedicated
bot token with issue, content, and pull-request write access. Submit
`deploy/smoke-workflow.yaml` with `make smoke`,
`deploy/execute-smoke-workflow.yaml` with `make smoke-execute`, the manual
supervisor with `make supervise`, the automatic first-ticket variant with
`make auto`, or the explicit
`deploy/publish-workflow.yaml` with `make publish-issue` after the Secret exists.

Start a publishing run with an issue number and optional PR base branch:

```bash
make publish-issue NAMESPACE=demo ISSUE=3622 BASE=feature/argo-workflows-ui
```

The execute template currently uses OpenAI OAuth for the OpenCode sidecar. Copy
only the local OpenAI entry into the required Secret without printing or storing
the token in a manifest:

```bash
jq -c '{apiVersion:"v1",kind:"Secret",metadata:{name:"adk-coding-workflow-opencode-auth",namespace:"demo"},type:"Opaque",stringData:{"auth.json":({openai:.openai}|tojson)}}' \
  ~/.local/share/opencode/auth.json | \
  kubectl --kubeconfig ~/.kube/solid-crocodile.yaml apply -f -
```

This is suitable only for an explicit prototype test: it copies a personal,
expiring OAuth credential into the cluster. The Secret is mounted only in the
OpenCode sidecar and copied to its ephemeral writable home so OpenCode can
refresh it during the run. Production automation should use a dedicated,
revocable service credential instead.

The `execute` template uses internal `implement` mode with OpenCode 1.18.10 as a
loopback-only sidecar and `openai/gpt-5.6-sol`. OpenCode does not receive the
GitHub token. A subsequent Argo pod performs the fixed validation command without
GitHub, model, or Kubernetes credentials. The Argo `init` and `wait` containers
alone receive the narrowly scoped executor service-account token. Validation
reconstructs `HEAD + changes.patch` in scratch space, so ignored files cannot
affect tests and generated code cannot overwrite retained results or patches.
Workspaces, structured results, and bounded patch files are retained on a
workflow-owned PVC until the Workflow is deleted or its one-day TTL expires.
An `onExit` reporter publishes an allowlisted, size-limited `workflow-result`
output with the outcome, branch, changed files, and validated GitHub pull-request
URL. It mounts the workspace read-only and receives no application credentials.
Publishing hashes the validated patch, attests the unchanged PVC worktree, then
runs a model-free finalizer that verifies or completes the workflow's claim,
commits and pushes the fixed branch, and creates a normal unmerged pull request.
The finalizer retries under the same workflow identity and recognizes completed
claims, pushes, and PRs. Manually specified runs that do not use the supervisor
retain the safe late-claim behavior in the finalizer.

### Supervisor Contracts

Submit `deploy/supervisor-workflow.yaml`, or reference
`adk-coding-workflow-execute` with `entrypoint: supervise`. The workflow starts
without an issue and accepts one `discovery-request` parameter. Include labels
use AND semantics; any matching exclude label rejects the issue:

```json
{"projects":[{"provider":"github","project":"prokube/pkui","suggestedBaseBranch":"main"}],"includeLabels":["ready"],"excludeLabels":["in-progress","needs-discussion","needs-supervisor"]}
```

The optional `bot-login` parameter may name the expected GitHub bot. If set, it
must match the user authenticated by `GH_TOKEN`; otherwise the authenticated
login is used.

The manual `supervise` entrypoint publishes the candidate list and suspends at
`select-ticket` for pkui. The `auto-supervise` entrypoint uses the same ranked
list but selects only its first candidate and proceeds without suspension. An
empty list fails before a claim. Run one automatic ticket with:

```bash
make auto KUBECONFIG=~/.kube/solid-crocodile.yaml NAMESPACE=demo
```

Multiple automatic Workflow objects may be submitted concurrently, but their
short claim steps share the namespace mutex `adk-coding-workflow-ticket-claim`.
This prevents competing claim comments; implementation can overlap only after
different tickets have been claimed. The provided launcher starts one ticket.

Discovery requests are checked against a reviewed provider/project allowlist
before any provider call. The initial allowlist contains only
`github/prokube/pkui`; adding another provider or project requires an explicit
code change to `reviewedDiscoveryProjects`.

The `discover` node publishes the global output parameter `candidate-list` as:

```json
{"candidates":[{"provider":"github","project":"prokube/pkui","number":42,"title":"Issue title","author":"login","priority":"high","url":"https://github.com/prokube/pkui/issues/42","suggestedBaseBranch":"main"}],"truncated":false}
```

Candidate output is capped at 50 entries and contains no issue bodies, comments,
labels, blockers, or credentials. The manual workflow then suspends in template
`select-ticket`; the step/node display name is also `select-ticket`. Resume that
node by supplying both output parameters:

- `selected-ticket`: JSON with the selection identity, for example
  `{"provider":"github","project":"prokube/pkui","number":42}`.
- `base-branch`: a Git branch name, for example `main`.

The `revalidate-selection` node rejects selections absent from the published
list and fails closed if the issue, blockers, assignment, issue branch, open PR,
or selected base changed. It emits `ticket-repository`, `target-repository`,
`issue`, and `base` into the existing pipeline. The `claim-selected-ticket` node
then writes the workflow claim comment, adds `in-progress`, assigns the
authenticated bot, and removes `ready` before `execute-selected-ticket` starts.
Before mutating GitHub it atomically records the normalized ticket, workflow ID,
and authenticated bot in `/workspace/.workflow-claim.json` on the workflow PVC.
Execute and finalize accept that state only when the exact workflow marker and
sole bot assignment still match; foreign markers or assignees block the run.
Discovery, revalidation, and claiming have GitHub credentials but no model
credentials; implementation has model and read-only GitHub credentials;
validation, attestation, and reporting receive no application credential.
Existing direct submissions remain compatible because the WorkflowTemplate's
default entrypoint is still `execute` with the existing `ticket-repository`,
`target-repository`, `issue`, `base`, and `publish` parameters.

The workflow exit handler runs credentialed `reconcile-claim` before the public
`report` step. Reconciliation is a no-op without the durable same-run record, on
identity or ownership conflicts, or when either the fixed result or GitHub shows
a pull request. Otherwise it adds `needs-supervisor`, removes `in-progress` and
any residual `ready` from a partial claim, removes only the authenticated bot
assignment, and posts a bounded status/phase comment. Cleanup retries are
idempotent. Cleanup failure is tolerated so the
credential-free reporter always runs, and the existing `workflow-result` output
shape and name remain unchanged.

## Prototype Limitations

- There is no webhook server, periodic ready-issue reconciler, or review-event
  processing yet.
- ADK sessions and run results are in memory. GitHub is the durable source of
  truth for publish state.
- The local prototype assumes one dispatcher. GitHub label updates are not an
  atomic lock, so concurrent workers could duplicate work before deterministic
  branch and pull-request checks stop duplicate publication.
- The deployed `execute` worker runs in gVisor, but the deterministic worker and
  OpenCode still share one pod network namespace. Their credentials are isolated
  by container environment, not by separate network policies.
- The execute pod has no dedicated egress policy yet.
- OpenCode tool permissions and removed GitHub token variables do not constitute
  production process or filesystem isolation.
- The publisher rejects changed validation attestations, unexpected remotes,
  divergent branches, sensitive paths, and duplicate pull requests. Claim
  mutations are idempotent for retries under the same retained Workflow.
- Execute PVCs follow the Workflow's one-day TTL and are deleted with it.
- Local validation commands are operator-provided shell commands and must be
  reviewed; the deployed execute command is fixed in the template.
- Repository and validation commands have a 30-minute hard timeout, which is a
  prototype-wide default rather than a command-specific resource policy.
- Local and deployed `execute` permit up to three deterministic-validation
  repair attempts in the original agent session. The deployed workflow then
  repeats validation in a fresh,
  credential-isolated worktree before attestation; pull-request review
  remediation is not implemented.

The ADK dependency currently needs explicit transitive security overrides in
`package.json`. `bun audit` must remain clean before this prototype is built into
an image; remove the overrides when upstream dependency ranges include the fixed
versions directly.

These limitations are deliberate. The next useful increment is webhook
reconciliation and per-issue Argo synchronization, followed by separate network
boundaries for checkout, OpenCode, validation, and publishing.
