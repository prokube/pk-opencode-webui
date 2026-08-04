FROM oven/bun:1.3.9-alpine

RUN apk add --no-cache bash ca-certificates git openssh-client

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src

RUN mkdir -p /workspace && chown bun:bun /workspace
USER bun
WORKDIR /workspace

ENTRYPOINT ["bun", "/app/src/cli.ts"]
