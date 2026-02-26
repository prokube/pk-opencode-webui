# Agent Workflow

This document describes workflows for autonomous agents working on **prokube.ai OpenCode UI** - a standalone Web UI for OpenCode that runs in Kubeflow Notebooks.

- **Worker Agent**: Executes individual tasks
- **Supervisor Agent**: Coordinates multiple workers, handles escalations
- **Triage Agent**: Captures requests, writes self-contained issues, breaks down large work

---

# Project Context

## Tech Stack

- **Frontend**: SolidJS with TypeScript, Tailwind CSS
- **Backend**: OpenCode API server (separate process, not part of this repo)
- **Build**: Bun, esbuild
- **Deployment**: Docker image for Kubeflow Notebooks
- **Process Supervision**: s6-overlay

## Repository Structure

```
/
├── app-prefixable/     # SolidJS frontend
│   ├── src/
│   │   ├── components/ # UI components
│   │   ├── context/    # State management (SDK, MCP, etc.)
│   │   ├── pages/      # Page components
│   │   ├── sdk/        # OpenCode SDK (local copy)
│   │   └── utils/      # Utilities
│   ├── dev.ts          # Dev server
│   └── build.ts        # Production build
│
├── docker/             # Kubeflow notebook image
│   ├── Dockerfile
│   ├── serve-ui.ts     # Production server
│   └── s6/             # s6-overlay config
│
├── shared/             # Shared code between servers
│   └── prokube-endpoints.ts
│
├── .github/            # CI/CD workflows
├── AGENTS.md           # This file
└── README.md           # Project overview
```

## Key Resources

- `AGENTS.md` - This file (workflows and conventions)
- `docker/` - Docker image for Kubeflow deployment
- `app-prefixable/` - Custom SolidJS frontend
- `shared/` - Shared code between dev and production servers

## Reference Resources

When unsure how to implement a feature, consult the upstream OpenCode project:

- **Upstream Repo**: https://github.com/anomalyco/opencode
- Clone locally if needed: `git clone https://github.com/anomalyco/opencode /tmp/opencode-ref`
- Look for similar patterns, but adapt solutions to our prefix-aware architecture
- Do not copy code verbatim - understand and reimplement as needed

---

# Repository Rules

## Remote

| Remote   | Repository                      | Agent Access     |
| -------- | ------------------------------- | ---------------- |
| `origin` | `prokube/pk-opencode` (private) | **Push allowed** |

## Branches

| Branch        | Purpose                           |
| ------------- | --------------------------------- |
| `main`        | Main development branch (default) |
| `decouple-ui` | Current feature branch            |

---

# Conventions

## Branding

- The product name is **prokube.ai** (always lowercase, with ".ai" suffix)
- Never write "ProKube", "Prokube", or "prokube" without the ".ai" suffix in user-facing text

## HTTP Base Path Configuration

**CRITICAL**: Never hardcode paths in the frontend code!

```typescript
// CORRECT - Use prefix() from base-path context
import { useBasePath } from "../context/base-path";
const { prefix } = useBasePath();
const url = prefix("/api/session");

// CORRECT - Use serverUrl from path utils for SDK
import { serverUrl } from "../utils/path";
const client = createClient({ serverUrl });

// WRONG - Hardcoded path
fetch("/api/session");

// WRONG - Hardcoded prefix
fetch("/notebook/ns/name/api/session");
```

## Code Style

- Keep things in one function unless composable or reusable
- Avoid unnecessary destructuring. Use `obj.a` instead of `const { a } = obj`
- Avoid `try`/`catch` where possible
- Avoid using the `any` type
- Prefer single word variable names where possible
- Use Bun APIs when possible, like `Bun.file()`
- Rely on type inference; avoid explicit type annotations unless necessary

### Avoid let statements

```typescript
// Good
const foo = condition ? 1 : 2;

// Bad
let foo;
if (condition) foo = 1;
else foo = 2;
```

### Avoid else statements

```typescript
// Good
function foo() {
  if (condition) return 1;
  return 2;
}

// Bad
function foo() {
  if (condition) return 1;
  else return 2;
}
```

## Git Workflow

### Commits

```bash
# Stage specific files only (NEVER use git add -A or git add .)
git add app-prefixable/src/pages/session.tsx

# Commit with descriptive message
git commit -m "fix: description of what changed"
```

### Commit Message Format

- `feat:` New feature
- `fix:` Bug fix
- `refactor:` Code restructure
- `docs:` Documentation
- `chore:` Maintenance

### When to Push

**Do NOT push automatically after every commit.** Pushing triggers CI builds.

- Push only when the user explicitly requests it, or when a feature is complete
- For local development, commit locally but wait for user approval before pushing
- If unsure, ask the user: "Should I push these changes now?"

## Required GitHub CLI Extensions

The workflow requires the `gh-copilot-review` extension for requesting Copilot code reviews on PRs.

**Check if installed:**

```bash
gh extension list | grep copilot-review
```

**Install if missing:**

```bash
gh extension install ChrisCarini/gh-copilot-review
```

**Security Note:** Installing GitHub CLI extensions from third parties carries supply chain risk. Before installing, verify:
- The extension source repository is well-maintained
- Review the extension's code/README for suspicious behavior
- Check the author's reputation and the number of stars/users
- Consider pinning to a specific commit or tag for reproducibility

**Usage:**

```bash
# Request Copilot code review on a PR
gh copilot-review <pr-number>

# Example
gh copilot-review 87
```

> **Important:** The standard `gh pr edit --add-reviewer copilot` does NOT work for Copilot reviews. You must use the `gh copilot-review` extension.

### Related Issues

When working on multiple related issues (e.g., issues touching the same files):

1. Work in a single branch
2. Complete each issue as a separate commit
3. Submit as one PR linking all issues

Example:
```bash
git checkout -b docs-updates
git commit -m "docs: add attribution (closes #79)"
git commit -m "docs: add workflow guide (closes #80)"
gh pr create --title "docs: Documentation improvements" --body "Closes #79, closes #80"
```
---

# GitHub Labels

| Label               | Color                 | Purpose                                  |
| ------------------- | --------------------- | ---------------------------------------- |
| `ready`             | Green (#0E8A16)       | Well-scoped and ready for implementation |
| `in-progress`       | Yellow (#FBCA04)      | Currently being worked on                |
| `needs-supervisor`  | Red (#D93F0B)         | Blocked, needs guidance                  |
| `priority:critical` | Dark Red (#B60205)    | Security, data loss, or blocking         |
| `priority:high`     | Red (#D93F0B)         | Important feature or significant bug     |
| `priority:medium`   | Yellow (#FBCA04)      | Normal priority (default)                |
| `priority:low`      | Light Green (#C2E0C6) | Nice to have                             |

---

# Worker Agent

## Workflow (Single Task)

```
┌─────────────────────────────────────────────────────────┐
│  1. READ CONTEXT                                        │
│     - Read this file for workflow and conventions       │
├─────────────────────────────────────────────────────────┤
│  2. RECEIVE AND VERIFY TASK                             │
│     - You are given a specific issue number             │
│     - Run `gh api repos/:owner/:repo/issues/<n>` to     │
│       read full issue details                           │
├─────────────────────────────────────────────────────────┤
│  3. CREATE BRANCH                                       │
│     - Create a feature branch: git checkout -b issue-<n>│
├─────────────────────────────────────────────────────────┤
│  4. WORK ON TASK                                        │
│     - Implement the solution                            │
│     - Test your changes                                 │
│     - Follow code style guidelines                      │
├─────────────────────────────────────────────────────────┤
│  5. COMPLETE OR ESCALATE                                │
│                                                         │
│  IF COMPLETED:                                          │
│     - Stage specific files: git add <files>             │
│     - Commit with descriptive message                   │
│     - Push: git push -u origin issue-<n>                │
│     - Create PR: gh pr create --title "..." --body "..." │
│     - Link PR to issue in body: "Closes #<n>"           │
│                                                         │
│  IF BLOCKED:                                            │
│     - Commit any partial progress                       │
│     - Add comment to issue explaining blocker           │
└─────────────────────────────────────────────────────────┘
```

---

# Local Development

## Starting the Dev Environment

```bash
# 1. Start OpenCode API server (in a separate terminal, in your project dir)
cd /path/to/your/project
opencode serve

# 2. Start frontend dev server
cd app-prefixable
bun install
bun run dev
```

The dev server runs on `http://localhost:3000` and proxies API requests to the backend on port 4096.

## Environment Variables

| Variable    | Default                 | Description            |
| ----------- | ----------------------- | ---------------------- |
| `BASE_PATH` | `/`                     | URL prefix for the app |
| `PORT`      | `3000`                  | Dev server port        |
| `API_URL`   | `http://localhost:4096` | Backend API URL        |

---

# Troubleshooting

## Common Issues

1. **"Thinking" appears but no response**
   - Check OpenCode logs: `~/.local/share/opencode/log/*.log`
   - Verify provider credentials are valid

2. **API requests fail with 404**
   - Check that base path is being included
   - Verify proxy is stripping prefix correctly

3. **Review panel shows "Not a Git repository"**
   - The diff viewer only works in Git repositories
   - Initialize git: `git init && git add . && git commit -m "Initial"`

## Debug Endpoints

```bash
# Check session status
curl http://127.0.0.1:4096/session/status

# Check available providers
curl http://127.0.0.1:4096/provider
```

---

# Session Completion

When ending a work session:

1. **Commit changes**: Stage specific files, commit with clear message
2. **Ask before pushing**: Only push if user confirms
3. **Provide context**: Summarize what was done and what's next
