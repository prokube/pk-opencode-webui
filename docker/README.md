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

## Telegram Bridge (optional)

Both Docker images now include an optional Telegram bridge runtime at `/opt/opencode-ui/telegram-bridge.ts`.

The bridge forwards Telegram text messages to OpenCode sessions and sends responses back to Telegram.

### Bridge environment variables

| Variable | Default | Description |
|---|---|---|
| `TELEGRAM_BRIDGE_ENABLED` | `false` | Enable bridge process (Kubeflow s6 service only) |
| `TELEGRAM_BOT_TOKEN` | _(required)_ | Telegram bot token from BotFather |
| `TELEGRAM_MODE` | `polling` | Bridge mode: `polling` or `webhook` |
| `OPENCODE_API_URL` | `API_URL` or `http://127.0.0.1:4096` | OpenCode API base URL |
| `OPENCODE_DIRECTORY` | _(empty)_ | Optional OpenCode directory for session requests |
| `TELEGRAM_BRIDGE_PORT` | `4097` | Webhook listener port (webhook mode only) |
| `TELEGRAM_WEBHOOK_PATH` | `/webhook` | Webhook endpoint path |
| `TELEGRAM_WEBHOOK_URL` | _(empty)_ | Public webhook URL to register with Telegram |
| `TELEGRAM_WEBHOOK_SECRET` | _(empty)_ | Secret token validated from Telegram webhook header |

### Webhook deployment notes

When `TELEGRAM_MODE=webhook`, the bridge runs an HTTP listener inside the container and Telegram must be able to reach it from the public internet.

- Expose `TELEGRAM_BRIDGE_PORT` through your platform ingress/load balancer.
- Route the public webhook path to the bridge service, including any path prefix from your gateway.
- Set `TELEGRAM_WEBHOOK_URL` to the full public URL Telegram should call (for example, `https://example.com/telegram/webhook`).
- Use `TELEGRAM_WEBHOOK_SECRET` and configure your proxy to forward `x-telegram-bot-api-secret-token` unchanged.

### Build

```bash
# From repo root
docker build -f docker/kubeflow/Dockerfile -t opencode-web-kubeflow .
```
