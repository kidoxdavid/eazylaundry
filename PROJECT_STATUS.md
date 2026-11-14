# EazyLaundry — Project Status

_Last updated: 2026-11-14_

## Current phase
**Phase 1 — Platform Foundation: substantially complete (CI green on GitHub, run #3). Phase 2 — Core Operations: started (money package done).**
Decisions D1–D5 approved ("go with your recommendations"): dogfood-first launch · Stripe Connect · separate SSR storefront · operational ledger (not a GL) · driver PWA.

## Test results (local, real PostgreSQL 16)
| Suite | Tests | Result |
|---|---|---|
| `@eazy/database` permission catalogue | 3 | pass |
| `@eazy/api` tenant isolation — DB/RLS | 11 | pass |
| `@eazy/api` tenant isolation — HTTP + route-policy coverage | 8 | pass |
| `@eazy/api` auth, sessions, MFA, throttling, temp passwords | 13 | pass |
| `@eazy/api` RBAC / anti-escalation / branch scope / audit | 7 | pass |
| `@eazy/api` configuration engine | 4 | pass |
| `@eazy/money` rounding, allocation, tax (known cases + property tests vs independent oracle) | 16 | pass |
Total **62/62**. The isolation suite was mutation-checked: disabling RLS on `branches` makes 7 tests fail.
UI verified by a scripted Playwright run against the real API (register → add branch with server-side validation → add member → audit → sign out). No automated frontend tests yet.

## Completed (Phase 1)
- Monorepo (pnpm workspaces), TypeScript strict, GitHub Actions CI definition, docker-compose, bootstrap script.
- Database: forward-only SQL migration runner; three DB roles (`eazy_owner` for migrations, `eazy_app` NOBYPASSRLS non-owner for the API); UUIDv7 keys.
- **Tenant isolation:** forced RLS on every tenant table (catalog test enforces this), composite `(tenant_id, id)` FKs, per-transaction `SET LOCAL` context (cannot leak across pooled connections), fail-closed with no context, append-only triggers on audit and config history, narrow `SECURITY DEFINER` functions as the only user-creation/lookup path.
- Auth: Argon2id, opaque server-side sessions (hash stored), httpOnly + SameSite cookies, CSRF double-submit, idle + absolute expiry, account lockout, uniform failure responses, TOTP MFA (secret AES-GCM encrypted), per-IP throttling on credential routes, forced change of admin-issued temporary passwords (enforced server-side).
- Authorization: fail-closed global guard (routes without a policy are denied; a test enumerates all routes), permission catalogue + role templates copied per tenant, permission re-read every request, branch scoping, amount limits, anti-escalation rules (cannot grant/modify authority you lack, no self-modification, last-owner protection).
- Tenant registration (tenant + organization + branch + roles + owner in one transaction), branches (Canadian postal validation), members, roles, versioned configuration with branch > tenant > default resolution, audit log written in the same transaction as each change.
- Web shell (React/Vite/Tailwind/TanStack Query/React Hook Form/Zod): sign in/up, MFA code prompt, forced password change, branches, team, roles (read-only), settings, audit log; permission-aware navigation; business switcher.

## Phase 2 progress
- `@eazy/money`: bigint minor-unit money, exact decimal rates, rounding modes (half-up/half-even/up/down), largest-remainder allocation, configurable tax engine (multi-component, compound, inclusive/exclusive, line/order rounding). Inclusive pricing preserves the entered total exactly. Not yet wired into any API.
- Next: customers → services & price lists → server-side pricing engine (using this package) → orders/POS.

## Not done yet (Phase 1 gaps — honest list)
- Staging deployment / Terraform baseline. (CI now runs on GitHub and passes; the first runs failed because `db-bootstrap.sh` mishandled a superuser URL — fixed.)
- OpenAPI generation + typed client (isolation harness currently enumerates routes via Nest metadata instead).
- OTel/Sentry observability, Redis/BullMQ worker, outbox dispatcher (table exists, unused).
- Roles editing UI (API exists), password reset by email, email invitations (temporary passwords are used instead), email verification, MFA enforcement for owners.
- Frontend automated tests, accessibility audit, i18n scaffolding.
- Seed/demo-tenant tooling, generated ERD.

## Known limitations / technical debt
- Service queries rely on RLS for tenant filtering rather than repeating `WHERE tenant_id` (deliberate single source of truth; permission and branch checks are still in services).
- Failed logins are logged but not stored in the tenant audit log (no tenant context); a platform security-events stream arrives with the platform console.
- Session idle timeout is global config, not per tenant.
- Login reveals that the password was correct before asking for the MFA code (standard trade-off).

## Architectural decisions (changes since Phase 0)
- **ADR-003 amended:** Phase 1 uses plain parameterised `pg` with SQL-first migrations. Drizzle/Kysely will be re-evaluated when Phase 2 introduces complex queries. Rationale: tiny table surface so far; RLS context handling is explicit in `Database.withContext`.
- Registration never bypasses RLS: the context is set to the new tenant/user ids.
- Existing emails added as members keep their credentials and the response is identical (no account takeover/enumeration through invitations).

## Dependencies / external lead items
Stripe Connect account · Email domain auth (SPF/DKIM/DMARC) · Google Maps billing · AWS accounts · Legal docs · Design-partner recruitment · Reference hardware.

## Next milestones
1. Phase 2: customers, services & price lists, pricing/tax engine API on top of `@eazy/money`.
2. Still open from Phase 1: OpenAPI + typed client, staging deploy.
3. POS → orders → intake → labels/scan → workflow engine → QC/rework → handover → cash shifts.

## Unverified claims / research debt
Pricing, market size, competitor landscape, conversion and unit-economics targets are **hypotheses** (see `docs/discovery/12-risks-commercialization.md` §C).
