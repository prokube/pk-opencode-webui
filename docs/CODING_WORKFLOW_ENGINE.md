# Coding Workflow Engine

Status: Active implementation tracker

Last updated: 2026-08-06

Related design: [Autonomous Coding Workflows](AUTONOMOUS_CODING_WORKFLOWS.md)

## Objective

Build an engine that accepts a ticket and one or more explicitly allowed Git
repositories, implements the requested change in isolated workspaces, validates
each change deterministically, and produces one or more unmerged pull requests.

The delivery is intentionally incremental. The first milestone ends with one
manually submitted GitHub issue producing one validated pull request. Automatic
starts, multiple target repositories, and review remediation remain explicit
follow-up milestones.

## Product Contract

The engine contract is independent of Argo Workflows. Argo is the first
execution backend, not the product API.

```json
{
  "ticket": {
    "provider": "github",
    "repository": "prokube/pkui",
    "number": 3628
  },
  "targets": [
    {
      "repository": "prokube/pkui",
      "baseBranch": "main"
    }
  ],
  "publish": true
}
```

Future multi-repository requests use the same contract with additional explicit
targets. The agent may decide that an allowed target needs no change, but it may
not add repositories or widen credentials by itself.

## Result Contract

```json
{
  "phase": "completed",
  "summary": "Implemented and validated the requested change",
  "repositories": [
    {
      "repository": "prokube/pkui",
      "phase": "completed",
      "branch": "feature/issue-3628",
      "changedFiles": ["frontend/src/example.tsx"],
      "pullRequestUrl": "https://github.com/prokube/pkui/pull/3701"
    }
  ]
}
```

The first milestone may expose the existing flattened single-repository result
while the internal request model already uses a target list. The public result
migrates to `repositories[]` with the multi-repository milestone.

## Architecture

```text
Manual API, CLI, or pkui action
              |
              v
      Coding request validator
      - validate ticket reference
      - resolve explicit targets
      - enforce repository allowlist
      - resolve repository policies
              |
              v
          Coordinator
      - eligibility and deduplication
      - durable run identity
      - repository workspaces
      - aggregate state
              |
              v
         Argo Workflow
      - prepare clean checkout
      - validate clean baseline
      - run OpenCode implementation
      - deterministic validation
      - bounded same-session repair
      - isolated validation replay
      - attest immutable changeset
      - credentialed deterministic publish
      - credential-free result report
              |
              v
       Pull request result
              |
              v
        pkui run details
```

## Responsibility Boundaries

| Component | Responsibility |
| --- | --- |
| Request validator | Typed input, target allowlist, repository policy resolution |
| Coordinator | State transitions, idempotency, fan-out, aggregation |
| OpenCode | Repository inspection and bounded file changes |
| Repository policy | Base branch, setup, validation, branch and PR conventions |
| Validator | Baseline and changed-tree checks without application credentials |
| Attestor | Bind base SHA, patch SHA, file list, run ID, and ticket |
| Publisher | Claim, commit, push, and create PR without force-pushing |
| Reporter | Publish only allowlisted, bounded result fields |
| pkui | Display workflow graph, outcome, changed files, and PR links |

## Repository Policy

Repository-controlled commands are executable code. The first implementation
uses a reviewed, centrally bundled allowlist rather than blindly executing a
file from an arbitrary checkout.

```yaml
repository: prokube/pkui
baseBranch: main
allowedPathPrefixes:
  - frontend/src/modules/user-management/
setup:
  - cd frontend && npm ci --ignore-scripts
validate:
  - git diff --exit-code HEAD -- frontend/package.json frontend/package-lock.json
  - cd frontend && npm run typecheck
  - cd frontend && npm test -- src/modules/user-management --maxWorkers=2
    # retried once for existing flaky UI tests
publish:
  branchPattern: feature/issue-{ticket}
  draft: false
```

A later policy service may distribute signed policies. A repository file can be
used only after the repository itself is trusted and the policy revision is
approved outside untrusted ticket content.

The M1 request targets a user-management frontend ticket, so its reviewed pkui
policy permits only that module and runs its complete suite plus global frontend
typechecking. Change-aware frontend, backend, Helm, and combined profiles are
required before this policy accepts tickets outside that scope.

## Validation And Repair

1. Prepare the checkout at the configured base SHA.
2. Run the repository baseline before OpenCode edits files.
3. Stop as `blocked` if the clean base is already red.
4. Run the implementation in one OpenCode session.
5. Run deterministic validation commands independently.
6. Return only the failing command and bounded diagnostics to the same session.
7. Permit at most three repair attempts.
8. Replay validation in a fresh credential-free worktree.
9. Attest the validated patch before publishing.

## Publishing Safety

- GitHub credentials are absent from OpenCode and validation containers.
- The publisher verifies repository, base SHA, branch, remote URLs, and patch SHA.
- Pushes never use force.
- A changed remote head stops the run instead of overwriting concurrent work.
- Publishing is idempotent for the same run ID.
- Pull requests remain unmerged.

## Workflow Graph

Argo lifecycle hooks are represented by `nodeFlag.hooked` and are not normal
children of the main workflow node. pkui synthesizes a display-only edge from
the owning node's terminal `outboundNodes` to the hook. This preserves the real
execution order without mutating the Argo resource.

## Later Event Architecture

Automatic starts and reviews require a durable control plane above Argo:

```text
GitHub App webhooks ----+
                        v
Periodic reconciler -> Event gateway -> Dispatcher -> Coding request -> Argo
                                             |
                                             v
                                        State store
```

The dispatcher verifies webhook signatures, deduplicates delivery IDs, applies
eligibility policy, serializes writes per ticket or PR branch, and creates a
run. The reconciler recovers missed events and interrupted transitions.

Review remediation creates a new correlated run on the existing PR branch. It
loads unresolved review threads, verifies the expected remote head SHA, applies
bounded repairs, revalidates, and pushes a normal commit. It never force-pushes
or overwrites human changes.

## Delivery Milestones

### M1: Manual GitHub Ticket To Successful PR

- [x] Fetch and validate a GitHub issue.
- [x] Isolate checkout, implementation, validation, attestation, and publishing.
- [x] Keep GitHub and model credentials in separate containers.
- [x] Publish a bounded workflow result and render it in pkui.
- [x] Continue validation repairs in the original OpenCode session.
- [x] Add a clean-base validation gate and three-attempt repair limit.
- [x] Connect Argo exit hooks in the pkui execution graph.
- [x] Build a worker image with Node 22, Python 3.11, uv, Helm, and kubectl.
- [x] Introduce a typed coding request with an explicit target list.
- [x] Replace hardcoded repository and validation arguments with an allowlisted policy registry.
- [x] Make the Argo template accept ticket repository and target repository parameters.
- [x] Cover request validation, policy resolution, and unsupported repositories.
- [x] Run all prototype and pkui quality gates.
- [ ] Build, push, and deploy the worker and pkui images.
- [ ] Submit issue `prokube/pkui#3628` through the request contract.
- [ ] Produce a validated, unmerged pull request.
- [ ] Verify the PR URL and connected graph through the live pkui API and UI.

M1 exit criterion: one manual request produces a green pull request and pkui
shows the structured result with a direct PR link.

### M2: Multiple Target Repositories

- [ ] Select reviewed validation profiles from planned changed-path families.
- [ ] Add one isolated workspace and result per target repository.
- [ ] Produce a structured plan mapping ticket requirements to allowed targets.
- [ ] Fan out implementation and validation per repository.
- [ ] Aggregate validation before publishing any branch.
- [ ] Create correlated draft PRs with a shared changeset ID.
- [ ] Publish `repositories[]` and `pullRequests[]` results.
- [ ] Add partial-publish recovery without automatic merge or force-push.

### M3: Automatic Starts

- [ ] Create a GitHub App with short-lived repository-scoped tokens.
- [ ] Verify and persist webhook events.
- [ ] Start eligible issues on `ready` label transitions.
- [ ] Add `/prokube run` and pkui manual triggers.
- [ ] Add delivery deduplication and per-ticket synchronization.
- [ ] Add periodic reconciliation for missed events.

### M4: Review And CI Remediation

- [ ] Correlate PRs, branches, runs, and changesets.
- [ ] Ingest review, review-comment, and check-suite events.
- [ ] Debounce and persist unresolved review threads.
- [ ] Verify remote head SHA before every remediation push.
- [ ] Apply bounded review repairs and reply with resulting commits.
- [ ] Ignore bot-authored events and processed review IDs.
- [ ] Escalate after three unsuccessful review cycles.

## Current Decisions

| Decision | Status |
| --- | --- |
| GitHub is the first ticket and repository provider | Accepted |
| Target repositories are explicit and allowlisted | Accepted |
| Argo is an execution backend, not the product contract | Accepted |
| M1 supports one target while using a future-compatible target list | Accepted |
| Repository policies are centrally reviewed in M1 | Accepted |
| Pull requests are never merged automatically | Accepted |
| Automatic starts and review remediation begin after M1 | Accepted |
