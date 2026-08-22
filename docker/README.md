# Docker Images

This directory contains Docker configurations for running OpenCode Web.

## Generic Image (`Dockerfile`)

A minimal image that runs only the UI server. Suitable for:
- Docker Compose setups
- General reverse proxy deployments (nginx, traefik)
- Kubernetes deployments (without Kubeflow)

### Build

```bash
# From repo root
docker build -f docker/Dockerfile -t opencode-web .
```

### Run

The UI server requires the OpenCode API server to be running. You can either:

1. Run them separately:
```bash
# Start API server (in your project directory)
opencode serve --port 4096

# Start UI server
docker run -p 8080:8080 \
  -e API_URL=http://host.docker.internal:4096 \
  -e BASE_PATH=/ \
  opencode-web
```

2. Use Docker Compose (recommended):
```yaml
version: '3.8'
services:
  api:
    image: your-opencode-api-image
    # ... API server configuration
    
  ui:
    build:
      context: .
      dockerfile: docker/Dockerfile
    ports:
      - "8080:8080"
    environment:
      - API_URL=http://api:4096
      - BASE_PATH=/
```

### Environment Variables

| Variable        | Default                 | Description                          |
|-----------------|-------------------------|--------------------------------------|
| `PORT`          | `8080`                  | Port the UI server listens on        |
| `API_URL`       | `http://127.0.0.1:4096` | OpenCode API server URL              |
| `BASE_PATH`     | `/`                     | URL prefix for reverse proxy support |
| `BRANDING_NAME` | (empty)                 | Optional branding name shown in UI   |
| `BRANDING_URL`  | (empty)                 | Optional URL for branding link       |

## Kubeflow Image (`kubeflow/Dockerfile`)

A full-featured image for Kubeflow Notebooks that includes:
- OpenCode CLI pre-installed
- s6-overlay process supervisor
- Kubeflow-compatible user (jovyan, UID 1000)
- Automatic home directory setup for PVCs

See [kubeflow/README.md](kubeflow/README.md) for details.

### Build

```bash
# From repo root
docker build -f docker/kubeflow/Dockerfile -t opencode-web-kubeflow .
```
