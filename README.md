# pk-opencode-webui

A feature-rich, prefix-aware Web UI for [OpenCode](https://github.com/anomalyco/opencode). Designed to work behind reverse proxies and in Kubeflow Notebooks -- but runs great anywhere.

![Active Session](docs/active-session.png)

## Highlights

- **Full reverse proxy support** -- every URL, asset, and API call respects the configured base path
- **Multi-project workspace** -- switch between projects without restarting; each gets its own session
- **MCP server management** -- add, remove, connect, and disconnect MCP servers from the UI
- **Command palette** -- VS Code-style quick navigation with fuzzy search
- **Keyboard hint mode** -- Vimium-like overlay for mouse-free navigation
- **AI session rename** -- let the LLM suggest concise titles for your sessions
- **Sound notifications** -- synthesized audio cues when tasks complete (no external files)
- **Desktop notifications** -- per-session browser notifications for background tasks
- **Saved prompts** -- build a reusable prompt library
- **Auto-accept permissions** -- skip confirmation dialogs for file edits on trusted projects
- **Custom branding** -- white-label with your own name, URL, and icon via environment variables
- **Kubeflow-native image** -- s6-overlay, PVC-aware home directory, SSH key fixing, rootless operation

## Why This Project?

The official OpenCode web UI assumes it runs at the root path `/`. This breaks behind reverse proxies that add URL prefixes:

- `/notebook/namespace/name/` (Kubeflow Notebooks)
- `/proxy/8080/` (JupyterHub)
- `/apps/opencode/` (custom setups)

There's an [upstream PR](https://github.com/anomalyco/opencode/pull/7625) attempting to fix this with runtime regex patching, but fonts and other resources loaded via JavaScript still use hardcoded `/assets/` paths. With 1,500+ open PRs in the upstream repo, a proper fix is unlikely to land soon.

**This project is a complete reimplementation of the web UI** -- it connects to the standard `opencode serve` backend. Every URL, asset reference, and API call respects the configured prefix. Along the way, we added a lot of features the upstream UI doesn't have.

## Feature Comparison

| Feature | Upstream OpenCode Web UI | pk-opencode-webui |
|---|---|---|
| Base path / prefix support | Hardcoded to `/` | Full runtime prefix detection |
| Reverse proxy support | Broken | Works out of the box (nginx, Traefik examples included) |
| Kubeflow integration | None | Full (NB_PREFIX, s6-overlay, jovyan user, PVC handling) |
| Multi-project support | Single project | Multiple projects with sidebar and live status badges |
| Project picker | None | Directory browser with fuzzy search, git clone, folder creation |
| MCP management UI | CLI only | Full graphical add/remove/connect/disconnect with OAuth support |
| Permission auto-accept | None | Per-directory toggle for trusted projects |
| AI session rename | None | LLM-powered title suggestions |
| Sound notifications | None | 5 synthesized sounds, configurable per type |
| Saved prompts | None | Full create/edit/delete/reorder library |
| Hint mode (Vimium-style) | None | Keyboard-driven navigation overlay |
| Command palette | None | Category-filtered fuzzy search (`>` commands, `@` sessions, `#` projects) |
| Desktop notifications | None | Per-session toggle with cross-tab sync |
| Custom branding | None | Name, URL, and icon via environment variables |
| Extended server API | None | Directory listing, mkdir, file write, MCP config deletion |
| Docker images | None | Generic (Alpine) and Kubeflow variants |
| Security hardening | Basic | Path traversal prevention, XSS escaping, rootless containers |

## Features In-Depth

### Multi-Project Workspace

Open multiple projects simultaneously. Each project directory is encoded in the URL, so you can bookmark or share links to specific sessions. The sidebar shows all open projects with live status badges -- you'll see at a glance if a session needs attention (permission request, question waiting, or busy).

The **project picker** page offers:
- Recent projects list with relative timestamps
- Directory browser with fuzzy search and Tab-completion (shell-like)
- Inline folder creation
- Git clone with a live terminal showing progress

### MCP Server Management

Add and manage [Model Context Protocol](https://modelcontextprotocol.io/) servers directly from the UI:

- Connect/disconnect servers with toggle switches
- Add remote servers with URL, custom headers, and OAuth configuration
- Status indicators: Connected, Disabled, Failed, Needs Auth, Needs Registration
- Delete servers with confirmation
- RFC 7591 automatic client registration support

### Command Palette & Hint Mode

**Command palette** (VS Code-style): fuzzy search across commands, sessions, and projects. Use prefix filters -- `>` for commands, `@` for sessions, `#` for projects. Tab cycles through categories.

**Hint mode** (Vimium-style): activates an overlay showing letter labels on every clickable element. Type the letters to click without touching the mouse. Uses home-row keys for ergonomic access.

### Sound & Desktop Notifications

**Sound notifications** use the Web Audio API to synthesize five distinct sounds (Chime, Ping, Duo, Alert, Gentle) -- no external audio files needed. Each sound type is independently configurable in Settings.

**Desktop notifications** can be toggled per-session. When a background session completes a task, you get a browser notification. Settings sync across tabs.

### Saved Prompts & AI Rename

Build a **prompt library** -- save, edit, reorder, and quickly insert frequently-used prompts. Accessible from Settings or the command palette.

**AI Rename** uses the LLM (via a temporary child session) to suggest concise titles for your chat sessions, replacing the default "Session 1, Session 2..." naming.

### Auto-Accept Permissions

For trusted projects, enable **auto-accept** to automatically approve file edit and write permissions without confirmation dialogs. Toggled per-directory, persisted in localStorage, with a visual indicator in the session header.

### Settings

A full settings page with tabs for:

1. **Providers** -- configure API keys, run OAuth flows (including device code flow)
2. **Git** -- view SSH keys, configure Git settings
3. **MCP** -- manage MCP servers (see above)
4. **Prompts** -- saved prompt library
5. **Instructions** -- edit project-level instruction files (AGENTS.md, etc.) with inline editor
6. **Appearance** -- Light / Dark / System theme
7. **Sounds** -- notification sound configuration with preview

## Quick Start

### Prerequisites

This project uses [Bun](https://bun.sh) -- a fast JavaScript runtime and package manager:

```bash
# macOS / Linux
curl -fsSL https://bun.sh/install | bash

# Windows
powershell -c "irm bun.sh/install.ps1 | iex"

# Or via npm
npm install -g bun
```

### Running

**1. Start the upstream OpenCode server** (in your project directory):

```bash
cd /your/project
opencode serve  # from the official OpenCode CLI
```

**2. Start the Web UI**:

```bash
cd app-prefixable
bun install && bun run dev
```

**3. Open** http://localhost:3000

## Configuration

| Variable | Default | Description |
|---|---|---|
| `BASE_PATH` | `/` | URL prefix for the app |
| `PORT` | `3000` (dev) / `8080` (Docker) | Server port |
| `API_URL` | `http://127.0.0.1:4096` | OpenCode API URL |
| `BRANDING_NAME` | _(empty)_ | Branding text shown as "Powered by {name}" |
| `BRANDING_URL` | _(empty)_ | URL for the branding link |
| `BRANDING_ICON` | _(empty)_ | Custom icon URL (HTTP, relative path, or data URI) |

## Deployment

### Docker (Generic)

```bash
# Build
docker build -f docker/Dockerfile -t opencode-web .

# Run without prefix
docker run -p 8080:8080 \
  --add-host=host.docker.internal:host-gateway \
  -e API_URL=http://host.docker.internal:4096 \
  opencode-web
# Access at http://localhost:8080

# Run with prefix (requires reverse proxy in front)
docker run -p 8080:8080 \
  --add-host=host.docker.internal:host-gateway \
  -e API_URL=http://host.docker.internal:4096 \
  -e BASE_PATH=/apps/opencode/ \
  opencode-web
# Access via your reverse proxy at /apps/opencode/
```

See [docker/README.md](docker/README.md) for Docker Compose examples.

### Kubeflow Notebooks

A specialized image with s6-overlay process supervision, OpenCode CLI pre-installed, developer tools (neovim, fzf, ripgrep), and automatic `NB_PREFIX` detection:

```bash
docker build -f docker/kubeflow/Dockerfile -t opencode-web-kubeflow .
```

Kubeflow-specific features:
- **PVC-aware home directory** -- copies template files without overwriting existing data
- **SSH key permission fixing** -- corrects permissions after PVC remount
- **Rootless operation** -- runs as `jovyan` (UID 1000), no SUID/SGID bits
- **Optional examples repo** -- clone a starter repo on first boot via `KF_EXAMPLES_REPO` build arg

See [docker/kubeflow/README.md](docker/kubeflow/README.md) for Kubeflow deployment details.

### Reverse Proxy Examples

See [examples/](examples/) for nginx and Traefik configurations.

## Architecture

```
+------------------------------------------------------------------+
|  This Project                                                    |
|                                                                  |
|  +------------------------------------------------------------+  |
|  |  Browser                                                   |  |
|  |                                                            |  |
|  |  +------------------------------------------------------+  |  |
|  |  |  SolidJS Frontend                                    |  |  |
|  |  |                                                      |  |  |
|  |  |  - Multi-project session management                  |  |  |
|  |  |  - Chat interface with streaming                     |  |  |
|  |  |  - Review panel (git diffs)                          |  |  |
|  |  |  - Terminal emulator                                 |  |  |
|  |  |  - MCP server management                             |  |  |
|  |  |  - Command palette, hint mode, saved prompts         |  |  |
|  |  |  - Sound & desktop notifications                     |  |  |
|  |  +------------------------------------------------------+  |  |
|  |                                                            |  |
|  +------------------------------------------------------------+  |
|                              |                                   |
|                  HTTP / SSE / WebSocket                          |
|                              v                                   |
|  +------------------------------------------------------------+  |
|  |  UI Server (Bun)                                           |  |
|  |                                                            |  |
|  |  - Serves static files with correct base path              |  |
|  |  - Proxies API requests to OpenCode server                 |  |
|  |  - Extended endpoints (/api/ext/mkdir, list-dirs, mcp)     |  |
|  |  - WebSocket proxy for PTY (terminal) sessions             |  |
|  +------------------------------------------------------------+  |
|                                                                  |
+------------------------------------------------------------------+
                               |
                               v
+------------------------------------------------------------------+
|  Upstream OpenCode Server (opencode serve)                       |
|                                                                  |
|  - Session management          - LLM provider communication      |
|  - Tool execution              - Terminal (PTY) management       |
+------------------------------------------------------------------+
```

## Building

```bash
cd app-prefixable
bun run build.ts
# Output in dist/
```

The build uses esbuild with the SolidJS plugin, PostCSS + Tailwind CSS, code splitting, and relative public paths (`./`) so assets resolve correctly under any prefix.

## Security

- **Path traversal prevention** -- all extended API endpoints validate paths and restrict operations to allowed directories
- **XSS prevention** -- base paths are HTML-escaped before DOM injection; config objects use `JSON.stringify`
- **URL validation** -- branding URLs are checked against `javascript:` and unsafe `data:` schemes
- **Rootless containers** -- Kubeflow image runs as non-root with all SUID/SGID bits removed
- **Workspace restriction** -- `OPENCODE_WORKSPACE_ROOT` limits filesystem operations to a defined boundary

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md)

## License

MIT -- See [LICENSE](LICENSE)
