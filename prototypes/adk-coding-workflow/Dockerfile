FROM oven/bun:1.3.9-alpine

ARG OPENCODE_VERSION=1.18.10
ARG OPENCODE_SHA256=9ba337873804891254d4dad37cb4cc06465006ddeebb1c1f55f2eedb1e775f7e

RUN apk add --no-cache bash ca-certificates curl git nodejs npm openssh-client && \
    curl -fsSL -o /tmp/opencode.tar.gz \
      "https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-linux-x64-musl.tar.gz" && \
    echo "${OPENCODE_SHA256}  /tmp/opencode.tar.gz" | sha256sum -c - && \
    tar -xzf /tmp/opencode.tar.gz -C /usr/local/bin && \
    rm /tmp/opencode.tar.gz

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src

RUN mkdir -p /workspace && chown bun:bun /workspace
USER bun
WORKDIR /workspace

ENTRYPOINT ["bun", "/app/src/cli.ts"]
