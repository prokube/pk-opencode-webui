# =============================================================================
# OpenCode Prefixable UI - Kubeflow Notebook Image
# =============================================================================
# This image runs the prefix-aware OpenCode Web UI with the OpenCode API server.
# It supports dynamic URL prefixes via NB_PREFIX environment variable.
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1: Build the app-prefixable UI
# -----------------------------------------------------------------------------
FROM oven/bun:1-alpine AS builder

WORKDIR /app

# Copy app-prefixable and shared directories
COPY app-prefixable ./app-prefixable
COPY shared ./shared

# Install dependencies and build
WORKDIR /app/app-prefixable
RUN bun install
RUN bun run build

# -----------------------------------------------------------------------------
# Stage 2: Runtime
# -----------------------------------------------------------------------------
FROM debian:bookworm-slim

# Install system packages
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    bash \
    build-essential \
    ca-certificates \
    curl \
    fzf \
    git \
    gh \
    gzip \
    htop \
    jq \
    less \
    neovim \
    openssh-client \
    pkg-config \
    python3 \
    python3-pip \
    ripgrep \
    tar \
    tree \
    unzip \
    xz-utils && \
    rm -rf /var/lib/apt/lists/*

# Install Bun
ARG BUN_VERSION=1.1.42
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" && \
    mv /root/.bun/bin/bun /usr/local/bin/bun && \
    rm -rf /root/.bun

# Install OpenCode CLI. Update OPENCODE_VERSION after checking upstream releases.
ARG OPENCODE_VERSION=1.15.7
ENV SHELL=/bin/bash
RUN curl -fsSL https://opencode.ai/install | bash -s -- --version "${OPENCODE_VERSION}" && \
    mv /root/.opencode/bin/opencode /usr/local/bin/opencode && \
    rm -rf /root/.opencode

# Install s6-overlay for process supervision
ARG S6_OVERLAY_VERSION=3.1.6.2
RUN case $(uname -m) in \
        x86_64) ARCH=x86_64 ;; \
        aarch64) ARCH=aarch64 ;; \
        *) echo "Unsupported architecture" && exit 1 ;; \
    esac && \
    curl -L "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-noarch.tar.xz" | tar -xJvf - -C / && \
    curl -L "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-${ARCH}.tar.xz" | tar -xJvf - -C /

# Create jovyan user with UID 1000 (Kubeflow standard)
RUN groupadd --gid 1000 jovyan && \
    useradd --uid 1000 --gid jovyan --home-dir /home/jovyan --shell /bin/bash --create-home jovyan

# Create directories (including s6 runtime directory for rootless mode)
# /run must be writable by jovyan for s6-overlay's preinit writability test
RUN mkdir -p /home/jovyan/.config/opencode \
             /home/jovyan/.config/gh \
             /home/jovyan/.local/share/gh \
             /home/jovyan/.local/share/opencode \
             /home/jovyan/.s6-runtime \
             /opt/opencode-ui \
             /tmp_home \
             /run

RUN printf 'git_protocol: https\nversion: "1"\n' > /home/jovyan/.config/gh/config.yml && \
    printf 'github.com:\n    git_protocol: https\n' > /home/jovyan/.config/gh/hosts.yml && \
    chmod 600 /home/jovyan/.config/gh/hosts.yml

# Install GitHub Copilot review extension for the runtime user.
# The extension has no tags/releases, so pin to an audited commit for reproducibility.
ARG GH_COPILOT_REVIEW_REF=1dfe6cd4abf66f8d45cbc0b3de26cf202fd27910
RUN mkdir -p /home/jovyan/.local/share/gh/extensions/gh-copilot-review && \
    git -C /home/jovyan/.local/share/gh/extensions/gh-copilot-review init && \
    git -C /home/jovyan/.local/share/gh/extensions/gh-copilot-review remote add origin https://github.com/ChrisCarini/gh-copilot-review && \
    git -C /home/jovyan/.local/share/gh/extensions/gh-copilot-review fetch --depth 1 origin "${GH_COPILOT_REVIEW_REF}" && \
    git -C /home/jovyan/.local/share/gh/extensions/gh-copilot-review checkout FETCH_HEAD

# Copy default OpenCode config (disables amazon-bedrock to avoid S3/MinIO credential confusion)
COPY docker/kubeflow/opencode-default-config.json /home/jovyan/.config/opencode/opencode.json

# Copy home template for container init
RUN cp -r /home/jovyan /tmp_home/

# Copy built UI from builder stage
COPY --from=builder /app/app-prefixable/dist /opt/opencode-ui/dist

# Copy server script (path relative to repo root)
COPY docker/serve-ui.ts /opt/opencode-ui/serve-ui.ts
COPY docker/telegram-bridge.ts /opt/opencode-ui/telegram-bridge.ts

# Copy shared modules (for serve-ui.ts imports)
COPY shared /opt/shared

# Copy s6 configuration
COPY docker/kubeflow/s6/ /etc/

# Copy startup script
COPY docker/kubeflow/start-server.sh /usr/local/bin/start-server.sh

# Set permissions
# /run must be owned by jovyan for s6-overlay rootless mode
RUN chmod -R 755 /etc/services.d/opencode /etc/services.d/telegram-bridge /etc/cont-init.d/ && \
    chmod +x /usr/local/bin/start-server.sh && \
    chown -R jovyan:jovyan /home/jovyan /tmp_home /opt/opencode-ui /run

# Remove all SUID/SGID bits from the image (required for restricted Pod Security Standards)
# This ensures no privilege escalation paths exist (covers /bin/su, /bin/mount, etc.)
RUN find / -type f \( -perm -4000 -o -perm -2000 \) -exec chmod ug-s {} \; 2>/dev/null || true

# Configure s6 for rootless operation (required for Kubernetes Pod Security Standards)
ENV S6_READ_ONLY_ROOT=1 \
    S6_RUNTIME_DIR=/home/jovyan/.s6-runtime

# Environment variables
ENV HOME=/home/jovyan \
    USER=jovyan \
    NB_USER=jovyan \
    NB_UID=1000 \
    HOME_TMP=/tmp_home/jovyan \
    OPENCODE_CONFIG_DIR=/home/jovyan/.config/opencode \
    OPENCODE_DISABLE_AUTOUPDATE=true \
    TERM=xterm-256color \
    SHELL=/bin/bash \
    PORT=8888

# Optional: Clone examples repository on startup (set via --build-arg)
ARG KF_EXAMPLES_REPO
ENV KF_EXAMPLES_REPO=${KF_EXAMPLES_REPO}

# Switch to jovyan user
USER jovyan

WORKDIR /home/jovyan

# Expose the web UI port (Kubeflow expects 8888)
EXPOSE 8888

# Use s6-overlay as init system
ENTRYPOINT ["/init"]
