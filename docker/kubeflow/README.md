# OpenCode Web - Kubeflow Notebook Image

This directory contains the Dockerfile and configuration for building a Kubeflow-compatible notebook image that runs the **prefix-aware OpenCode Web UI**.

## Overview

This image combines:

- **OpenCode API Server** (runs on internal port 4096)
- **Prefix-Aware Web UI** (serves on port 8888, proxies to API)
- **GitHub CLI and Copilot Review extension** (`gh` + `gh-copilot-review`)

The UI automatically adapts to any URL prefix set by Kubeflow's `NB_PREFIX` environment variable.

## Features

- **Runtime Prefix Detection**: No rebuild needed for different URL prefixes
- **Kubeflow Integration**: Automatic `NB_PREFIX` handling
- **Single Container**: Both API and UI run in one container
- **Persistent Storage**: Configuration stored in `/home/jovyan`
- **s6-overlay**: Proper process supervision and init

## Building

### From the repository root

```bash
# Build the image
docker build \
  --platform linux/amd64 \
  -t opencode-web-kubeflow:latest \
  -f docker/kubeflow/Dockerfile \
  .

# Or with build args
docker build \
  --platform linux/amd64 \
  -t opencode-web-kubeflow:latest \
  -f docker/kubeflow/Dockerfile \
  --build-arg S6_OVERLAY_VERSION=3.1.6.2 \
  --build-arg KF_EXAMPLES_REPO=https://github.com/your-org/examples.git \
  .
```

## Usage

### Local Testing

```bash
# Without base path
docker run -p 8888:8888 opencode-web-kubeflow

# With base path (simulating Kubeflow)
docker run -p 8888:8888 -e NB_PREFIX=/notebook/user/opencode/ opencode-web-kubeflow
```

### Kubeflow Deployment

The image is designed for Kubeflow notebook servers. It will automatically:

1. Detect the `NB_PREFIX` environment variable
2. Configure the UI to work under that prefix
3. Proxy API requests to the internal OpenCode server

Example Kubeflow notebook configuration:

```yaml
apiVersion: kubeflow.org/v1
kind: Notebook
metadata:
  name: opencode-prefixable
spec:
  template:
    spec:
      containers:
        - name: opencode
          image: your-registry/opencode-web-kubeflow:latest
          ports:
            - containerPort: 8888
              name: notebook-port
          volumeMounts:
            - mountPath: /home/jovyan
              name: workspace
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Container (Port 8888)                    │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              Bun UI Server (serve-ui.ts)            │    │
│  │                                                      │    │
│  │  /notebook/user/opencode/*  →  Static Files (dist/) │    │
│  │  /session, /event, /api/*   →  Proxy to :4096       │    │
│  └─────────────────────────────────────────────────────┘    │
│                            │                                 │
│                            ▼                                 │
│  ┌─────────────────────────────────────────────────────┐    │
│  │         OpenCode API Server (Port 4096)              │    │
│  │                                                      │    │
│  │  Sessions, Providers, MCP, Files, PTY, etc.         │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Environment Variables

| Variable           | Default                 | Description                       |
| ------------------ | ----------------------- | --------------------------------- |
| `NB_PREFIX`        | `/`                     | URL path prefix (set by Kubeflow) |
| `BASE_PATH`        | `/`                     | Alternative to NB_PREFIX          |
| `API_URL`          | `http://127.0.0.1:4096` | Internal API server URL           |
| `KF_EXAMPLES_REPO` | (empty)                 | Git repo to clone on startup      |
| `BRANDING_NAME`    | (empty)                 | Optional branding name shown in UI|
| `BRANDING_URL`     | (empty)                 | Optional URL for branding link    |

## Preinstalled Developer Tooling

- `gh` is preinstalled in the image and available to the runtime user (`jovyan`).
- `gh-copilot-review` is preinstalled for `jovyan` and can be used with `gh copilot-review <pr-number>`.
- The extension is pinned in `docker/kubeflow/Dockerfile` via `GH_COPILOT_REVIEW_REF` for reproducible builds.

## Configuration Directories

| Path                                  | Description                 |
| ------------------------------------- | --------------------------- |
| `/home/jovyan/.config/opencode/`      | OpenCode configuration      |
| `/home/jovyan/.local/share/opencode/` | OpenCode data/sessions      |
| `/opt/opencode-ui/dist/`              | Built UI assets (read-only) |

## Process Supervision

The container uses s6-overlay with the following structure:

```
/etc/
├── cont-init.d/
│   ├── 01-setup-home           # Set up home directory
│   ├── 02-clone-examples       # Clone examples repository (optional)
│   └── 03-fix-ssh-permissions  # Fix SSH key permissions for mounted keys
└── services.d/
    └── opencode/
        └── run                 # Start API + UI servers
```

## Development

To iterate on the UI:

1. Make changes in `app-prefixable/`
2. Test locally with `bun run dev`
3. Rebuild the Docker image
4. Test in Kubeflow

## Troubleshooting

### UI shows blank page

- Check browser console for errors
- Verify `NB_PREFIX` is set correctly
- Check container logs: `kubectl logs <pod-name>`

### API requests fail

- Ensure the internal API server started (check logs for "API server is ready")
- Verify proxy paths in `serve-ui.ts` match API endpoints

### Assets not loading

- Check that `<base href>` is correctly set in HTML
- Verify static files exist in `/opt/opencode-ui/dist/`
