# Web (React SPA) served by unprivileged nginx, which also proxies /api to the API so cookies stay first-party.
FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter "@eazy/web..."
COPY apps/web apps/web
RUN pnpm --filter @eazy/web build

FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY infrastructure/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
