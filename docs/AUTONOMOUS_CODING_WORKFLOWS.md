# Autonomous Coding Workflows

Status: Draft for discussion

Prototype: [`prototypes/adk-coding-workflow/`](../prototypes/adk-coding-workflow/README.md)

## Purpose

This document proposes how prokube.ai can turn GitHub issues into reviewed pull
requests by combining deterministic workflow orchestration, isolated OpenCode
workers, and kagent-facing agent interfaces.

The first use case is intentionally narrow:

1. Discover an unassigned GitHub issue labeled `ready`.
2. Claim it without racing another worker.
3. Implement it in an isolated workspace with OpenCode.
4. Run repository-defined validation.
5. Open a pull request, but never merge it automatically.
6. React to trusted pull-request reviews and comments with bounded remediation
   runs on the existing branch.

The same foundation should later support workflows containing deterministic
steps, agent steps, schedules, events, conditions, parallel branches, and human
approval points.

## Goals

- Keep issue selection, retries, credentials, Git operations, and state
  transitions deterministic.
- Use OpenCode for bounded implementation and review-remediation steps.
- Execute each coding attempt in an isolated, disposable workload.
- Expose coding capabilities through kagent without making kagent the workflow
  engine.
- Preserve a clear audit trail from issue through workflow runs, commits,
  reviews, and pull request.
- Support repository-specific instructions such as `AGENTS.md`, tests, build
  commands, and allowed automation levels.
- Start with Argo Workflows while keeping the product-level workflow contract
  independent of Argo custom resources.

## Non-Goals

- Automatically merging pull requests.
- Letting an LLM decide which repositories, credentials, or permissions it may
  use.
- Running multiple issue jobs in one interactive OpenCode home directory.
- Treating kagent chat sessions as a durable workflow queue.
- Exposing raw Argo Workflow YAML as the long-term user-facing workflow API.
- Providing arbitrary commenters with a way to execute code in the cluster.

## Design Principles

### Deterministic control, agentic implementation

The workflow controller owns operations whose outcome must be reproducible:

- GitHub event validation and issue eligibility checks
- issue claims, leases, labels, and assignments
- repository checkout and branch selection
- credentials and secret projection
- test invocation and timeout policy
- diff and policy inspection
- commits, pushes, pull-request creation, and comments
- retries, cancellation, cleanup, and retention

OpenCode receives an issue, repository instructions, and a checked-out working
directory. It may inspect and modify files and run approved development tools,
but it does not own the surrounding workflow.

### One isolated workspace per run

Every issue or remediation attempt gets its own pod and workspace volume. A
long-lived shared `/home/jovyan` PVC is useful for interactive development but
is not an acceptable isolation boundary for autonomous jobs.

### Credentials stay outside the agent

The first version may use a dedicated bot account with a fine-grained GitHub
PAT, but the OpenCode process should not receive that token. Deterministic
checkout and publishing steps use the credential before and after the agent
step. A GitHub App with short-lived installation tokens remains the preferred
production target.

### Product contract before engine contract

Argo Workflows is the proposed first execution engine. prokube.ai should define
its own smaller workflow and run model, then compile it to Argo resources. This
keeps the door open for another engine if long-lived signaling or workflow
semantics outgrow Argo.

## System Overview

```text
GitHub webhook                    Periodic reconciliation
       |                                    |
       +----------------+-------------------+
                        v
              Workflow dispatcher
              - verify event and actor
              - check ready/dependencies
              - deduplicate and claim
              - create workflow run
                        |
                        v
                 Argo Workflow
       +----------------+----------------+
       |                                 |
deterministic steps                 agent steps
- fetch context                     - OpenCode implement
- clone/branch                      - OpenCode remediate
- tests and policy                  - optional kagent/A2A
- commit/push/PR
- comments and status
       |                                 |
       +----------------+----------------+
                        v
                 Pull request
                        |
                        v
             Review webhook events
                        |
                        v
          Review-remediation workflow
```

## Proposed Components

### Workflow dispatcher

A small service receives GitHub webhooks and performs periodic reconciliation.
It is responsible for:

- webhook signature validation
- repository and organization allowlists
- trusted-actor and command authorization
- issue dependency and assignment checks
- durable deduplication and leases
- workflow submission and correlation
- reconciliation after missed events or controller restarts
- mapping issues, pull requests, branches, comments, and workflow runs

Argo Events may deliver events, but event filtering alone is not enough to
implement a safe check-and-claim transaction. The dispatcher remains the
authority for eligibility and idempotency.

### Workflow API

The product-facing API stores `WorkflowDefinition` and `WorkflowRun` records.
It validates definitions, resolves policy, and compiles runs into Argo
`Workflow` resources.

Initial node types should be:

| Node type | Purpose |
| --- | --- |
| `container` | Run a deterministic Kubernetes task |
| `http` | Call an allowlisted API with a typed contract |
| `opencode` | Run an isolated OpenCode coding task |
| `a2a` | Invoke a kagent/A2A agent |
| `condition` | Branch on structured outputs |
| `parallel` | Fan out and join independent branches |
| `approval` | Suspend until an authorized decision or timeout |
| `schedule` | Start from cron or periodic configuration |

Every executable node should declare typed inputs and outputs, timeout, retry
policy, resource limits, service account, secret references, artifact handling,
and cancellation behavior.

### OpenCode worker

The existing repository is primarily an interactive web UI around
`opencode serve`. Autonomous execution should share its runtime but use a
dedicated worker entry point.

The image structure should evolve toward:

| Image | Responsibility |
| --- | --- |
| `pk-opencode-runtime` | OpenCode, Git, language tooling, and shared configuration |
| `pk-opencode-webui` | Runtime plus the interactive prefix-aware UI |
| `pk-opencode-worker` | Runtime plus a noninteractive workflow runner |
| `pk-opencode-a2a` | Optional A2A facade over workflow runs |

The worker should use the OpenCode HTTP API so a run has a durable session and
observable event stream:

1. Create a session for the checked-out directory.
2. Submit the task through `prompt_async`.
3. Monitor session status, events, pending permissions, and questions.
4. Apply server-side permission policy rather than browser-local auto-accept.
5. Stop on timeout, cancellation, or an unsupported question.
6. Return a structured result and retain sanitized session artifacts.

Suggested worker result states are `completed`, `blocked`, `failed`,
`cancelled`, and `no-change`.

### GitHub publisher

The publisher is deterministic and runs after the agent and validation steps.
It receives the bot credential and is responsible for:

- checking that the remote branch head has not changed unexpectedly
- staging only intended changed files
- creating the commit with the configured bot identity
- pushing without force
- creating or updating the pull request
- linking the issue with `Closes #N`
- replying to addressed review comments
- recording commit and pull-request identifiers on the workflow run

The publisher must refuse to overwrite a branch that changed after checkout.

### kagent integration

kagent should expose the coding capability, not implement the workflow engine.
The first integration can be a declarative kagent Agent connected to a workflow
MCP server with tools such as:

```text
start_coding_run(repository, issue)
get_coding_run(run_id)
cancel_coding_run(run_id)
list_coding_runs(repository, status)
```

This provides a conversational coding-agent experience while keeping execution
state in the workflow control plane.

A later BYO A2A adapter can map an A2A task to a `WorkflowRun` and stream Argo
status updates. The adapter should not host a shared source checkout or execute
repository tests in its long-lived pod.

## Argo Workflows Fit

ArgoCD and Argo Workflows are separate products. The current platform
installation must be checked for the `Workflow`, `WorkflowTemplate`, and
`CronWorkflow` CRDs before assuming Argo Workflows is available.

Argo Workflows is sufficient for the proposed first stages because it provides:

- durable Kubernetes workflow resources
- DAG and step execution
- retries, timeouts, conditions, and parallelism
- workflow-level volumes and artifacts
- cron scheduling
- suspend and resume steps
- native pod isolation and resource policy

Argo is less suitable than Temporal for code-level deterministic replay,
arbitrary signals into a long-lived execution, workflow queries, and complex
processes that remain active for months. For issue and pull-request automation,
separate correlated workflows are acceptable:

```text
issue implementation workflow
review remediation workflow 1
review remediation workflow 2
```

The workflow service keeps those runs correlated to one issue and pull request.
This avoids requiring one long-lived workflow while preserving a complete audit
trail.

### Verified `solid-crocodile` baseline

The `solid-crocodile` cluster was inspected read-only on 4 August 2026. A
server-side dry run of a generic Workflow was also accepted; no probe resource
was persisted.

| Area | Observed state |
| --- | --- |
| Kubernetes | MicroK8s, server v1.35.6 |
| ArgoCD | Installed separately in `argocd`, v3.4.2 |
| Workflow CRDs | `Workflow`, `WorkflowTemplate`, `ClusterWorkflowTemplate`, `CronWorkflow`, and supporting v1alpha1 CRDs are installed |
| Workflow controller | One KFP-owned `workflow-controller:v3.7.3` Deployment in `kubeflow` |
| Controller scope | `managedNamespace` and `instanceID` are empty, so it watches unlabeled Workflows across namespaces |
| Argo Server | Not installed |
| Argo Events | EventBus, EventSource, and Sensor CRDs are not installed |
| Workflow archive | Disabled; no Argo persistence database is configured |
| Artifacts | KFP controller default uses the `mlpipeline` MinIO bucket and KFP `s3creds`; Kubeflow Profiles receive namespace-specific artifact repositories |
| Current inventory | No active Workflow, WorkflowTemplate, or CronWorkflow objects at inspection time |
| Storage | `openebs-hostpath` is the default StorageClass |
| Isolated runtimes | `gvisor` is available; a Kata RuntimeClass is not installed |
| Local tooling | The Argo CLI is not installed on the inspection client |

The KFP controller is technically capable of running generic workflows. Its
ClusterRole can create pods and PVCs across namespaces, and the inspecting
identity can create Workflow resources. A dedicated workflow service account
and executor RBAC are still required; the inspecting user's permission is not a
runtime authorization design.

The existing controller should not be treated as the production control plane
for coding workflows:

- its lifecycle and configuration are owned by Kubeflow Pipelines
- its artifact settings and credentials are KFP-specific
- workflow archival and durable run history are disabled
- it has no Argo Server or event delivery subsystem
- it is shared with KFP and platform tests, including workloads that can exhaust
  namespace pod quotas
- the observed controller pod had restarted 11 times since 22 July, with the
  latest terminated state reporting exit code 255 and API connectivity errors
  in the previous log

For a constrained proof of concept, the existing v3.7.3 controller can process
an unlabeled Workflow in a dedicated namespace. The proof of concept must use
its own service accounts, ResourceQuota, NetworkPolicies, artifact repository,
workspace PVC, and TTL strategy. It must not use the `kubeflow` namespace or
KFP's `s3creds` and `mlpipeline` bucket.

For production, deploy a dedicated controller with an `instanceID`, for example
`prokube-coding`, and label every owned Workflow with
`workflows.argoproj.io/controller-instanceid: prokube-coding`. Argo's controller
contract states that a controller without an instance ID watches only Workflows
that do not carry an instance-ID label, allowing the KFP controller and the
prokube.ai controller to share CRDs without reconciling the same objects.

The first dedicated controller should match v3.7.3 to avoid CRD skew. Its chart
must not attempt to adopt or replace KFP-owned CRDs until platform ownership and
upgrade sequencing are explicitly agreed. An Argo Server is optional because
the workflow API and pkui will provide the product interface. Argo Events is
also optional because the dispatcher can receive GitHub webhooks directly and
submit Workflows through the Kubernetes API.

## Issue-To-Pull-Request Workflow

### Discovery

Use both GitHub webhooks and a periodic reconciler. Webhooks provide low
latency; reconciliation discovers pre-existing issues and repairs missed
events.

An issue is eligible only when:

- it is open
- it has the `ready` label
- it has neither `in-progress` nor `needs-discussion`
- it has no assignee
- it has no open native blockers
- no active workflow lease exists
- no open pull request already closes it
- the repository is allowlisted and has an automation policy

### Claim

The dispatcher creates a durable lease, then updates GitHub:

- remove `ready`
- add `in-progress`
- assign the bot
- comment with the workflow-run link

If GitHub mutation fails, the dispatcher reconciles or releases the lease. A
label is useful status, but it is not the sole lock.

### Prepare

The deterministic preparation step:

- fetches the issue, comments, related epic, dependencies, and repository
  policy
- clones the repository from its configured base branch
- creates the repository-required issue branch or worktree
- removes Git credentials before the OpenCode container starts
- builds a cold-start task package with explicit acceptance criteria

Issue and comment text is untrusted input. It must be presented to OpenCode as
task context, never as higher-authority configuration that can override system
policy, repository instructions, permissions, or secret boundaries.

### Implement

OpenCode reads repository instructions and implements one issue. The worker may
edit files and run allowlisted local commands. It may not push, create pull
requests, change issue labels, install new OpenCode plugins, or access GitHub
credentials.

If OpenCode asks a question that cannot be answered from policy, the worker
returns `blocked`. The workflow comments with the question, applies the
repository's escalation label, and stops.

### Validate

Tests and formatters run as deterministic steps defined by repository policy.
They must have independent timeouts and captured logs. An optional second agent
may review the diff, but it cannot override failing required checks.

### Publish

When validation succeeds, the publisher commits, pushes, and opens a pull
request. The pull request remains unmerged and enters the normal human and CI
review process.

## Review-Remediation Workflow

The dispatcher listens for:

- `pull_request_review`
- `pull_request_review_comment`
- `issue_comment` on pull requests
- relevant pull-request updates
- CI/check completion events when failure remediation is enabled

Automatic execution is limited to trusted maintainers, configured review bots,
and explicit commands such as `/agent fix`. The dispatcher verifies the actor's
repository permission through GitHub rather than trusting a username in event
content.

Before starting a remediation run, the dispatcher verifies:

- the pull request is still open
- its branch is owned by an allowed organization or bot
- the publisher can update the branch
- the event is not from the automation bot itself
- the review or comment has not already been processed
- the maximum remediation cycle count has not been reached

The remediation task package contains the original issue and epic, pull-request
body, current diff, all reviews, inline threads and replies, relevant CI status,
sanitized failure logs, repository instructions, and previous remediation
attempts.

Findings are classified as:

| Classification | Outcome |
| --- | --- |
| `fix` | Change code, validate, push, and reply with the commit |
| `stale` | Explain why the current diff no longer contains the finding |
| `out-of-scope` | Create or link a follow-up issue and reply |
| `disagree` | Reply with a technical explanation without changing code |
| `needs-discussion` | Stop and request human guidance |

The workflow batches unresolved comments where practical. It must compare the
remote head SHA before publishing and stop rather than overwrite concurrent
work.

To prevent loops:

- ignore the bot's own comments and reviews
- persist processed event and comment IDs
- debounce bursts of comments into one run
- do not request another review when no code changed
- cap automatic remediation cycles, initially at three
- escalate repeated findings or failures to a human

## GitHub Authentication

The first version targets a dedicated bot account with a fine-grained PAT
restricted to selected repositories and these permissions:

| Permission | Access |
| --- | --- |
| Metadata | Read |
| Issues | Read and write |
| Contents | Read and write |
| Pull requests | Read and write |

Webhook delivery also requires a separate webhook secret.

The PAT must be stored in the cluster secret manager, rotated, and projected
only into deterministic GitHub steps. It must not be copied into the workspace,
OpenCode configuration, session artifacts, command output, or logs.

The production design should replace the PAT with a GitHub App to gain
short-lived installation tokens, explicit installation scope, stronger audit
identity, and easier revocation.

## Security Boundaries

Autonomous coding runs execute repository-controlled code and package scripts.
They must be treated as untrusted workloads.

Minimum controls are:

- one disposable pod and workspace per run
- a restricted service account with no Kubernetes API credential where possible
- no host filesystem or privileged container access
- a strong runtime boundary such as Kata for test execution
- explicit CPU, memory, storage, process, and wall-clock limits
- managed egress for Git hosts and required package registries
- no GitHub or platform credentials during agent and test steps
- bounded artifact size and retention
- secret and identity redaction in logs
- cleanup after success, failure, cancellation, and controller restart

Repository instructions cannot widen these controls. Adding a new repository
requires an administrative allowlist and policy review.

## Repository Automation Policy

Each automated repository should provide a reviewed policy outside untrusted
issue text. A possible initial shape is:

```yaml
repository: prokube/pkui
baseBranch: main
branchPattern: feature/issue-{number}
maxParallelRuns: 1
maxRemediationCycles: 3
instructions:
  - AGENTS.md
validation:
  - make test-unit
publish:
  draftPullRequest: false
  merge: never
trustedReviewers:
  - geier
  - hsteude
trustedBots:
  - copilot-pull-request-reviewer[bot]
```

This example is illustrative. The final schema needs validation, command
allowlists, timeouts, resource profiles, artifact limits, and a clear ownership
model.

## State And Idempotency

The workflow control plane needs durable records beyond GitHub labels and Argo
status. At minimum it stores:

- repository and issue number
- event delivery IDs and processed comment IDs
- claim lease and lease expiry
- workflow and attempt IDs
- base and head commit SHAs
- branch and pull-request number
- OpenCode session identifiers
- current phase and structured result
- remediation count
- artifact references and retention deadline

The dispatcher reconciles this state with GitHub and Argo after restart. Every
external mutation uses an idempotency key or checks existing state before
creating another branch, comment, workflow, or pull request.

## Observability And Operations

Operators need:

- run state, duration, retries, queue latency, and result metrics
- per-step logs with secret redaction
- model, token, and estimated-cost reporting
- links between issue, workflow, OpenCode session, commit, pull request, and
  review runs
- cancellation and safe retry controls
- alerts for stuck leases, repeated failures, credential errors, and cleanup
  failures
- retention controls for source workspaces, logs, diffs, and session data

The interactive Web UI may later attach to a running or retained OpenCode
session for diagnosis. It is an observability interface, not the source of
workflow state or unattended permissions.

## Deployment And Ownership

Proposed ownership boundaries are:

| Area | Owner |
| --- | --- |
| Shared OpenCode runtime, worker, and optional A2A adapter | `pk-opencode-webui` / `pk-opencode` |
| Workflow API, dispatcher, Argo compiler, and reconciler | New workflow-control-plane repository |
| Workflow and run UI, capability gate, and kagent UX | `pkui` |
| GitOps installation and environment values | `prokube` |
| Agent Gateway public routing for a new A2A path family | `prokube-neo` |
| Sandbox runtime integration when workflows use managed Sandboxes | `pk-sandbox` |

Direct installation support belongs with the owning charts. GitOps Applications
and environment values remain in the `prokube` repository.

## Delivery Plan

### Current prototype

The repository contains an initial TypeScript ADK prototype with three explicit
modes:

- `plan` validates issue eligibility without mutating GitHub or a repository
- `execute` prepares an isolated worktree, invokes OpenCode, and runs validation
  without publishing
- `publish` additionally claims the issue, commits, pushes, and creates an
  unmerged pull request

The prototype uses SQLite for local run records and leases and drives the
workflow through an ADK `BaseAgent`. It is intentionally a local validation of
the control-flow boundaries, not a production service. Webhooks, review
remediation, distributed leases, Kubernetes isolation, durable ADK sessions,
and Argo execution remain later phases.

### Phase 0: Verify foundations

- Use the verified v3.7.3 KFP controller only for the first constrained proof of
  concept.
- Define the dedicated controller instance, namespace, service accounts, RBAC,
  quotas, network policy, and CRD ownership plan for production.
- Select the workflow state store and artifact repository.
- Create the dedicated GitHub bot and fine-grained PAT.
- Define one repository allowlist and automation policy.
- Validate controller stability and resource behavior under representative
  coding-workflow load.

### Phase 1: Manual issue proof of concept

- Start a workflow manually with repository and issue number.
- Clone and prepare an isolated workspace.
- Run OpenCode without GitHub credentials.
- Execute required tests deterministically.
- Publish one unmerged pull request.

### Phase 2: Automatic ready-issue processing

- Add webhook handling and periodic reconciliation.
- Implement dependency checks, claims, leases, and deduplication.
- Add issue status comments and workflow links.
- Limit initial concurrency to one active issue per repository.

### Phase 3: Review remediation

- Process trusted changes-requested reviews and `/agent fix` commands.
- Batch unresolved review threads.
- Push fixes to the existing branch.
- Add head-SHA concurrency checks and a three-cycle limit.

### Phase 4: kagent integration

- Expose workflow tools through an MCP server.
- Ship a declarative Coding Agent using those tools.
- Add a BYO A2A adapter only when direct A2A task semantics are needed.

### Phase 5: General workflow product

- Introduce product-level workflow definitions and runs.
- Add deterministic, OpenCode, A2A, condition, parallel, approval, and schedule
  node types.
- Build run history, inspection, cancellation, and approval UI in pkui.
- Re-evaluate Argo versus Temporal using observed workflow requirements.

### Phase 6: Production hardening

- Replace the PAT with a GitHub App.
- Expand isolation, egress, policy, audit, cost, and retention controls.
- Add disaster recovery and stale-run reconciliation tests.
- Increase repository and workflow concurrency deliberately.

## Initial Validation Scenarios

The proof of concept is not complete until it covers:

- duplicate webhook delivery
- an issue with an open blocker
- two dispatchers racing to claim the same issue
- OpenCode requesting human clarification
- no file changes
- validation failure
- timeout and cancellation
- remote branch changing during execution
- push or pull-request creation failure
- a review burst containing multiple inline comments
- the bot receiving its own review reply event
- the maximum remediation cycle being reached
- worker and dispatcher restart during active runs
- prompt-injection text in an issue or review comment
- verification that the OpenCode and test containers cannot read the GitHub PAT

## Open Decisions

1. Should the workflow control plane be a new repository and service, or begin
   inside `pk-opencode` for the proof of concept?
2. Which persistent store should hold workflow correlation and leases?
3. Should coding-workflow artifacts use a dedicated MinIO bucket or another
   artifact store?
4. Should the first coding workers use gVisor pods or the `pk-sandbox` control
   plane, given that Kata is not installed on the inspected cluster?
5. Which model/provider and cost limits apply to unattended coding runs?
6. Which review bots and human roles may trigger automatic remediation?
7. How long should workspaces and OpenCode sessions remain available for
   inspection after a run?
8. When should the platform take ownership of Argo Workflow CRD upgrades rather
   than consuming the versions installed with Kubeflow Pipelines?
9. Which requirements would justify moving future workflows from Argo to
   Temporal rather than extending the prokube.ai workflow abstraction?
