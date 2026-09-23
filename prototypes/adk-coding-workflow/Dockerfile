FROM oven/bun:1.3.9-debian AS bun

FROM node:22.22-bookworm-slim

ARG OPENCODE_VERSION=1.18.10
ARG OPENCODE_SHA256=6b1113da704253fb4da12b41e4236acecb9f2b62949c945f6eeacaa15111b976
ARG UV_VERSION=0.9.5
ARG HELM_VERSION=3.17.3
ARG HELM_SHA256=ee88b3c851ae6466a3de507f7be73fe94d54cbf2987cbaa3d1a3832ea331f2cd
ARG KUBECTL_VERSION=1.36.1

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

RUN apt-get update && \
    apt-get install -y --no-install-recommends bash ca-certificates curl git make openssh-client python3 python3-venv && \
    rm -rf /var/lib/apt/lists/* && \
    python3 -m venv /opt/uv && \
    /opt/uv/bin/pip install --no-cache-dir "uv==${UV_VERSION}" && \
    ln -s /opt/uv/bin/uv /usr/local/bin/uv && \
    curl -fsSL -o /tmp/opencode.tar.gz \
      "https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-linux-x64.tar.gz" && \
    echo "${OPENCODE_SHA256}  /tmp/opencode.tar.gz" | sha256sum -c - && \
    tar -xzf /tmp/opencode.tar.gz -C /usr/local/bin && \
    curl -fsSL -o /tmp/helm.tar.gz "https://get.helm.sh/helm-v${HELM_VERSION}-linux-amd64.tar.gz" && \
    echo "${HELM_SHA256}  /tmp/helm.tar.gz" | sha256sum -c - && \
    tar -xzf /tmp/helm.tar.gz -C /tmp && \
    install -m 0755 /tmp/linux-amd64/helm /usr/local/bin/helm && \
    curl -fsSL -o /usr/local/bin/kubectl "https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/amd64/kubectl" && \
    curl -fsSL -o /tmp/kubectl.sha256 "https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/amd64/kubectl.sha256" && \
    echo "$(cat /tmp/kubectl.sha256)  /usr/local/bin/kubectl" | sha256sum -c - && \
    chmod 0755 /usr/local/bin/kubectl && \
    rm -rf /tmp/opencode.tar.gz /tmp/helm.tar.gz /tmp/linux-amd64 /tmp/kubectl.sha256

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src

RUN mkdir -p /workspace && chown node:node /workspace
USER node
WORKDIR /workspace

ENTRYPOINT ["bun", "/app/src/cli.ts"]
