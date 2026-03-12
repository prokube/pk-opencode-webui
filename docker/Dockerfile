# =============================================================================
# OpenCode Web - Generic Docker Image
# =============================================================================
# A prefix-aware Web UI for OpenCode that works behind reverse proxies.
# Supports dynamic URL prefixes via BASE_PATH environment variable.
#
# OpenCode source: By default, builds from a fork with memory-leak fixes.
# Override via --build-arg:
#   OPENCODE_REPO=https://github.com/anomalyco/opencode.git
#   OPENCODE_REF=dev
# Or to use the upstream pre-built installer instead:
#   OPENCODE_BUILD_FROM_SOURCE=false
#   OPENCODE_VERSION=1.2.6
#
# For Kubeflow-specific deployments, see docker/kubeflow/Dockerfile
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1: Build the UI
# -----------------------------------------------------------------------------
FROM oven/bun:1-alpine AS ui-builder

WORKDIR /app

# Copy source
COPY app-prefixable ./app-prefixable
COPY shared ./shared

# Install dependencies and build
WORKDIR /app/app-prefixable
RUN bun install
RUN bun run build

# -----------------------------------------------------------------------------
# Stage 2: Build OpenCode from source (conditional)
# -----------------------------------------------------------------------------
FROM oven/bun:1-alpine AS opencode-builder

ARG OPENCODE_BUILD_FROM_SOURCE=true
ARG OPENCODE_REPO=https://github.com/binarydoubling/opencode.git
ARG OPENCODE_REF=fix/memory-leaks

# Install git (needed for clone) and build dependencies
RUN apk add --no-cache git bash curl

WORKDIR /build

# Clone, install deps, and build the opencode binary (single-target for current platform)
# The build produces dist/opencode-linux-<arch>/bin/opencode
RUN if [ "$OPENCODE_BUILD_FROM_SOURCE" = "true" ]; then \
        git clone --depth 1 --branch "${OPENCODE_REF}" "${OPENCODE_REPO}" . && \
        bun install && \
        cd packages/opencode && \
        bun run build -- --single --skip-install && \
        mkdir -p /build/out && \
        cp dist/opencode-linux-*/bin/opencode /build/out/opencode; \
    else \
        mkdir -p /build/out && \
        echo "skipping source build" > /build/out/.skip; \
    fi

# -----------------------------------------------------------------------------
# Stage 3: Runtime
# -----------------------------------------------------------------------------
FROM oven/bun:1-alpine

# Install minimal dependencies
RUN apk add --no-cache \
    bash \
    git \
    curl \
    openssh-client

# Install OpenCode CLI — either from source build or upstream installer
ARG OPENCODE_BUILD_FROM_SOURCE=true
ARG OPENCODE_VERSION=1.2.6
ENV SHELL=/bin/bash
COPY --from=opencode-builder /build/out/ /tmp/opencode-build/
RUN if [ "$OPENCODE_BUILD_FROM_SOURCE" = "true" ] && [ -f /tmp/opencode-build/opencode ]; then \
        mv /tmp/opencode-build/opencode /usr/local/bin/opencode && \
        chmod +x /usr/local/bin/opencode; \
    else \
        curl -fsSL https://opencode.ai/install | bash -s -- --version "${OPENCODE_VERSION}" && \
        mv /root/.opencode/bin/opencode /usr/local/bin/opencode && \
        rm -rf /root/.opencode; \
    fi && \
    rm -rf /tmp/opencode-build

# Create app directory
RUN mkdir -p /opt/opencode-ui

# Copy built UI from builder stage
COPY --from=ui-builder /app/app-prefixable/dist /opt/opencode-ui/dist

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
