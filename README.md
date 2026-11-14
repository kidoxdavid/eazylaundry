# EazyLaundry

Multi-tenant laundry business management platform (SaaS + Eazy Group's own operation).
Status and decisions: [`PROJECT_STATUS.md`](PROJECT_STATUS.md) · Discovery pack: [`docs/discovery/`](docs/discovery/00-index-and-decisions.md)

## Develop
```bash
pnpm install
docker compose up -d postgres            # or use a local Postgres 16 + `pnpm db:bootstrap`
cp .env.example .env
pnpm db:migrate                           # runs as eazy_owner
pnpm dev:api                              # connects as eazy_app (no BYPASSRLS)
pnpm test                                 # includes tenant-isolation suites
```
Security model in one line: the API never connects as a table owner or bypass role; every request runs in a transaction with
`app.tenant_id` set from the authenticated session, and PostgreSQL RLS (forced) enforces isolation underneath service authorization.
