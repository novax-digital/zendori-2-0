# Build context is the repo root:
#   docker build -f apps/worker/Dockerfile .
# Node version pinned on purpose — no :latest, no auto-updates (CLAUDE.md §12).
FROM node:22.23.1-alpine

RUN corepack enable
WORKDIR /app

# manifests first for layer caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/worker/package.json apps/worker/
COPY packages/core/package.json packages/core/
COPY packages/channels/package.json packages/channels/
COPY packages/ai/package.json packages/ai/

RUN pnpm install --frozen-lockfile --filter @zendori/worker...

COPY packages ./packages
COPY apps/worker ./apps/worker

ENV NODE_ENV=production
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "apps/worker/bin/healthcheck.mjs"]

CMD ["pnpm", "--filter", "@zendori/worker", "start"]
