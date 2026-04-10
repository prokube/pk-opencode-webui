# Agent Instructions — pk-opencode-webui

> **Before reading this file:** You MUST first read `../agents/AGENTS.md`. It contains the reading map that tells you which additional files to read based on your role (conventions, code style, workflow). Those shared files apply to all repositories.

This file contains **pk-opencode-webui-specific** instructions only.

---

## Project Context

**prokube.ai OpenCode UI** - a standalone Web UI for OpenCode that runs in Kubeflow Notebooks.

### Tech Stack

- **Frontend**: SolidJS with TypeScript, Tailwind CSS
- **Backend**: OpenCode API server (separate process, not part of this repo)
- **Build**: Bun, esbuild
- **Deployment**: Docker image for Kubeflow Notebooks
- **Process Supervision**: s6-overlay

### Repository Structure

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
└── AGENTS.md           # This file
```

### Remote

| Remote   | Repository                      | Agent Access     |
|----------|---------------------------------|------------------|
| `origin` | `prokube/pk-opencode` (private) | **Push allowed** |

### Reference Resources

When unsure how to implement a feature, consult the upstream OpenCode project:
- **Upstream Repo**: https://github.com/anomalyco/opencode
- Clone locally if needed: `git clone https://github.com/anomalyco/opencode /tmp/opencode-ref`
- Look for similar patterns, but adapt to our prefix-aware architecture
- Do not copy code verbatim - understand and reimplement

---

## HTTP Base Path Configuration

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

---

## Code Style (SolidJS-specific)

- Keep things in one function unless composable or reusable
- Avoid unnecessary destructuring. Use `obj.a` instead of `const { a } = obj`
- Use Bun APIs when possible (e.g., `Bun.file()`)

---

## When to Push

**Do NOT push automatically after every commit.** Pushing triggers CI builds.

- Push only when the user explicitly requests it, or when a feature is complete
- For local development, commit locally but wait for user approval before pushing
- If unsure, ask the user: "Should I push these changes now?"

---

## Local Development

```bash
# 1. Start OpenCode API server (separate terminal)
cd /path/to/your/project
opencode serve

# 2. Start frontend dev server
cd app-prefixable
bun install
bun run dev
```

Dev server runs on `http://localhost:3000`, proxies API to port 4096.

### Environment Variables

| Variable    | Default                 | Description            |
|-------------|-------------------------|------------------------|
| `BASE_PATH` | `/`                     | URL prefix for the app |
| `PORT`      | `3000`                  | Dev server port        |
| `API_URL`   | `http://localhost:4096` | Backend API URL        |

---

## Troubleshooting

1. **"Thinking" appears but no response** - Check OpenCode logs: `~/.local/share/opencode/log/*.log`
2. **API requests fail with 404** - Check base path is included, verify proxy strips prefix
3. **"Not a Git repository"** - Diff viewer only works in Git repos

### Debug Endpoints

```bash
curl http://127.0.0.1:4096/session/status
curl http://127.0.0.1:4096/provider
```
