# Reverse Proxy Examples

Example configurations for running opencode-web behind different reverse proxies.

## Prerequisites

All examples assume:
1. OpenCode API server is running on your host machine (`opencode serve`)
2. Docker and Docker Compose are installed

## Examples

### nginx

Basic nginx reverse proxy serving the UI at `/apps/opencode/`:

```bash
cd examples/nginx
docker compose up
```

Open http://localhost/apps/opencode/

### Traefik

Traefik v3 reverse proxy with automatic path stripping:

```bash
cd examples/traefik
docker compose up
```

Open http://localhost/apps/opencode/

Traefik dashboard available at http://localhost:8081/

## Customizing the Path

To use a different prefix (e.g., `/myapp/`):

1. Update `BASE_PATH` environment variable in docker-compose.yml
2. Update the proxy configuration to match

### nginx

```nginx
location /myapp/ {
    proxy_pass http://opencode-ui/;
    # ... rest of config
}
```

### Traefik

```yaml
labels:
  - "traefik.http.routers.opencode.rule=PathPrefix(`/myapp`)"
  - "traefik.http.middlewares.opencode-strip.stripprefix.prefixes=/myapp"
```

## Troubleshooting

### WebSocket connection fails

Ensure your proxy configuration includes WebSocket upgrade headers:

```nginx
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
```

### SSE streaming doesn't work

Disable proxy buffering:

```nginx
proxy_buffering off;
proxy_cache off;
```

### Assets return 404

Verify that:
1. `BASE_PATH` matches your proxy prefix exactly (including trailing slash)
2. The proxy is correctly stripping the prefix before forwarding
