# =============================================================================
# OpenCode Web - Generic Docker Image
# =============================================================================
# A prefix-aware Web UI for OpenCode that works behind reverse proxies.
# Supports dynamic URL prefixes via BASE_PATH environment variable.
#
# For Kubeflow-specific deployments, see docker/kubeflow/Dockerfile
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1: Build the UI
# -----------------------------------------------------------------------------
FROM oven/bun:1-alpine AS builder

WORKDIR /app

# Copy source
COPY app-prefixable ./app-prefixable
COPY shared ./shared

# Install dependencies and build
WORKDIR /app/app-prefixable
RUN bun install
RUN bun run build

# -----------------------------------------------------------------------------
# Stage 2: Runtime
# -----------------------------------------------------------------------------
FROM oven/bun:1-alpine

# Install minimal dependencies
RUN apk add --no-cache \
    bash \
    git \
    curl \
    openssh-client

# Install OpenCode CLI (included for convenience - can be used to start API server
# via `opencode serve` or for CLI access within the container)
# Pin version to ensure reproducible builds. Update by changing OPENCODE_VERSION.
# Check releases at: https://github.com/anomalyco/opencode/releases
ARG OPENCODE_VERSION=1.2.6
ENV SHELL=/bin/bash
RUN curl -fsSL https://opencode.ai/install | bash -s -- --version "${OPENCODE_VERSION}" && \
    mv /root/.opencode/bin/opencode /usr/local/bin/opencode && \
    rm -rf /root/.opencode

# Create app directory
RUN mkdir -p /opt/opencode-ui

# Copy built UI from builder stage
COPY --from=builder /app/app-prefixable/dist /opt/opencode-ui/dist

# Copy server script
COPY docker/serve-ui.ts /opt/opencode-ui/serve-ui.ts

# Copy shared modules (for serve-ui.ts imports)
COPY shared /opt/shared

# Environment variables
ENV PORT=8080 \
    API_URL=http://127.0.0.1:4096 \
    BASE_PATH=/

WORKDIR /opt/opencode-ui

EXPOSE 8080

# Start the UI server
# Note: You need to run the OpenCode API server separately or use a process manager
CMD ["bun", "run", "serve-ui.ts"]
