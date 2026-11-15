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
| `@eazy/api` customers (CRUD, search, duplicates, addresses, consent history, permissions, cross-tenant) | 11 | pass |
| `@eazy/api` pricing engine (pure unit + property tests) | 9 | pass |
| `@eazy/api` catalogue, price history, branch overrides, tax rates, discounts/limits, cross-tenant | 11 | pass |
| `@eazy/api` orders & payments (idempotency incl. concurrent duplicates, gap-free numbering, multi-payment, cash change, cancel, receipts, branch RLS, cross-tenant) | 16 | pass |
| `@eazy/api` production workflow (stage permissions, double-scan races, optional skip, QC fail/rework, handover guard, scan, labels, board, branch/tenant isolation) | 15 | pass |
| `@eazy/money` rounding, allocation, tax (known cases + property tests vs independent oracle) | 16 | pass |
Total **127/127**. The isolation suite was mutation-checked: disabling RLS on `branches` makes 7 tests fail.
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
- **Customers (done):** tenant-scoped customers with E.164 phone normalisation, duplicate prevention by phone/email among live records (archive frees them), guests, Canadian addresses (postal/province validated in DB and API, one default per customer), append-only consent history (CASL-oriented), optimistic concurrency, trigram search, audit trail. UI: list/search, create, detail with edit, addresses, consent switches. Verified in a real browser.
- **Services, price lists & pricing engine (done):** categories, services (per kg / per item / fixed, tax category, express, turnaround), append-only price versions (history never rewritten; branch override beats the general price), default Standard price list and Alberta GST 5% seeded per tenant as editable data, effective-dated multi-component tax rates, config-driven tax mode (inclusive/exclusive) and rounding level. `POST /pricing/quote` is the single server-side pricing path (min charge, express, discount allocation, tax; discounts gated by `discount.apply` and its amount limit). UI: services & prices, change price, live price calculator, settings for tax mode/rounding. Verified in a real browser.
- **Orders, POS & payments (done, first slice):** `POST /orders` re-prices on the server via the same `PricingService` as `/pricing/quote`, writes an order with immutable price-snapshot lines and an append-only event history, allocates a gap-free per-branch/month order number (`MAIN-2611-00001`) under row lock, and optionally takes an initial payment atomically. Mandatory `Idempotency-Key` (same key + same payload replays; different payload rejected; concurrent duplicates serialise). Payments are separate from allocations (multi-payment, cash tendered/change, overpayment blocked under a row lock, duplicate submissions can't double-charge). Cancel only open unpaid orders. Receipt data endpoint (GST breakdown, branch-time-zone dates). Orders/payments/events/lines are append-only or immutable in the database; branch-limited staff are isolated by a restrictive RLS policy (mutation-tested). Express now applies only to lines whose service offers it.
- **Mobile-first UI (done):** responsive shell (top bar + slide-over menu on phones, sidebar on desktop), 44px touch targets and 16px inputs, bottom-sheet dialogs, POS (customer search / new / walk-in guest → tap services → weight or quantity → server quote → cash/card/e-transfer/other with change calculator → order number + receipt), orders list (cards on phones, table on desktop), order detail (payments, cancel, timeline), printable 80mm receipt. Verified on a 390×844 touch viewport and desktop with a real browser; no horizontal overflow on any of the 10 pages.
- **Production workflow (done, first slice):** per-business stages stored as data (default 11 stages: received → intake → sorting → washing → drying → ironing (optional) → folding → quality control → packaging → ready → handed over), each with the permission needed to complete it, so counter staff, machine operators and inspectors are separated; orders pin their workflow and carry a globally unique opaque scan token. `POST /orders/:id/advance` is safe against double scans and racing users (`fromStageKey` + row lock; verified with simultaneous requests) and can only skip optional stages. Quality inspection records pass/fail (immutable `quality_inspections`), a fail needs a reason and an earlier stage, increments the rework count and the order can finish after rework. Hand-over is blocked until the balance is paid. `GET /scan/:code` (token or order number) returns the order card plus what *this user* may do next; unknown and out-of-scope codes are indistinguishable (404). Production board (counts and cards from one query, overdue and slow-stage flags). Bag labels (QR + Code128, one per bag). Every transition is an append-only order event with actor, branch and time.
- **Production UI (done):** scan page (always-focused field for USB scanners, typed order numbers, camera scanning where the browser supports BarcodeDetector), stage tracker, big one-tap action buttons, Pass/Fail with reason and suggested rework stage, production board (tabs on phones, columns on desktop, refreshes every 15 s), labels dialog with print layout. Verified end to end on a 390×844 touch viewport with three separate user sessions (owner, technician, inspector); printed label QR and Code128 decoded correctly with an independent reader (zxing).
- Next: cash shifts, refunds/adjustments, work assignments, delivery stages and driver app, notifications.
- (superseded) services & price lists → server-side pricing engine (using this package) → orders/POS.

## Not done yet (Phase 1 gaps — honest list)
- Staging deployment / Terraform baseline. (CI now runs on GitHub and passes; the first runs failed because `db-bootstrap.sh` mishandled a superuser URL — fixed.)
- OpenAPI generation + typed client (isolation harness currently enumerates routes via Nest metadata instead).
- OTel/Sentry observability, Redis/BullMQ worker, outbox dispatcher (table exists, unused).
- Roles editing UI (API exists), password reset by email, email invitations (temporary passwords are used instead), email verification, MFA enforcement for owners.
- Frontend automated tests, accessibility audit, i18n scaffolding.
- Seed/demo-tenant tooling, generated ERD.

## Known limitations / technical debt
- Workflow: one default workflow per business (no per-service workflows yet) and no stage-editing UI — the API shape and data model support it. The suggested rework stage per failure reason is a code default. Hand-over reuses `order.create` (adding a dedicated permission needs the role-backfill path noted below). Delivery stages (assigned for delivery / delivered) and explicit work assignments/productivity tracking are not built. Intake inspection records (photos, damage notes) and garment-level tracking are not built. Board updates by 15-second polling, not live push (SSE planned).
- Camera scanning relies on the BarcodeDetector API (Chrome/Edge/Android); iOS Safari does not provide it, so iPhones fall back to typing or a Bluetooth/USB scanner.
- Label printing is browser print (62×40 mm layout); no ZPL/thermal printer agent yet.
- Orders cannot be edited after creation (cancel and re-create); order amendments/supplements and refunds are not built, so paid orders cannot be cancelled yet. No ledger postings yet (finance phase) — payments are recorded and reconciled to orders, but the double-entry ledger does not exist.
- Cash drawer shifts/reconciliation are not built, so cash payments are not tied to a shift yet.
- Promised time = longest service turnaround (express capped at 24h); business hours/holidays are not considered yet.
- Receipt printing is browser print (80mm CSS); no thermal printer agent, email/SMS receipts, or tenant-editable receipt template yet.
- Offline order entry is not supported yet (requires the PWA queue designed in the discovery pack); the app is responsive and touch-friendly but not yet installable/offline.
- Price lists of kind contract/customer exist in the schema but have no API/UI yet (Phase 3 commercial accounts). Bundles/packages and rule-based pricing (time/volume) are not built.
- Catalogue reads reuse `order.read` and quotes use `order.create` (no separate `catalogue.read`). Adding a NEW permission later needs a per-tenant backfill of role copies; migrations run as the owner role and cannot see tenant rows under FORCE RLS, so plan a controlled maintenance path before the first permission addition.
- Money crosses the API as integer minor units (JSON numbers, asserted safe) — documented convention.
- Customer phone numbers are displayed in E.164 (+17805550101) rather than a friendly format.
- Customer merge, tags, segments and CSV import are not built (later tier).
- Two Vite majors coexist in the workspace (web: 6, vitest: 7); the api vitest config casts the swc plugin. Align versions when convenient.
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
