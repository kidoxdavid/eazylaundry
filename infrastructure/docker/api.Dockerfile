# API (NestJS). Staging-grade: runs TypeScript through tsx. A compiled build is a later hardening step (see docs/deploy.md).
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY packages/database/package.json packages/database/
COPY packages/money/package.json packages/money/
RUN pnpm install --frozen-lockfile --filter "@eazy/api..." --filter "@eazy/database..."

FROM base AS runtime
ENV NODE_ENV=production PORT=3000
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=deps /app/packages ./packages
COPY package.json pnpm-workspace.yaml ./
COPY packages ./packages
COPY apps/api ./apps/api
RUN chown -R node:node /app
USER node
WORKDIR /app/apps/api
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=6 CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["./node_modules/.bin/tsx", "src/main.ts"]
