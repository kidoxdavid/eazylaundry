# 11 — Testing Strategy

## 1. Pyramid and tooling
| Layer | Tool | Scope | Gate |
|---|---|---|---|
| Unit | Vitest | money, pricing, tax, workflow rules, entitlement logic, permission checks | every PR; coverage floor on `money/pricing/ledger` ≥ 95 % branches |
| Property-based | fast-check | ledger balance, allocation sums, rounding, state machines | every PR |
| Integration (API+DB) | Vitest + Testcontainers (real Postgres w/ RLS, Redis) | each endpoint, migrations, outbox, webhooks | every PR |
| **Tenant isolation** | generated suite | for **every route** (auto-enumerated from OpenAPI) × every verb: tenant B principal calls with tenant A ids → must be 403/404 and DB-level direct query as role `app_rw` with wrong `app.tenant_id` → 0 rows; catalog test: all tenant tables have FORCE RLS + policy | **blocking** |
| Contract | Pact-style/recorded fakes | Stripe/email/SMS/maps adapters; webhook signature verify | PR + nightly sandbox run |
| E2E | Playwright | Tests 1–10 below, a11y (axe), visual regression | merge to main / nightly |
| Performance | k6 | POS order create, scan, board queries, dashboards; seeded 1M-order tenant | nightly + pre-release |
| Security | CodeQL, Trivy, npm audit, OWASP ZAP baseline, secret scan; pen-test pre-GA | CI + scheduled |
| Chaos/resilience | fault injection | provider outages, Redis loss, DB failover, duplicate/out-of-order webhooks | pre-release |
| Restore drill | scripted | backup → new env → integrity verification | quarterly + pre-GA |

## 2. Acceptance E2E mapped to brief
| # | Scenario | Key assertions |
|---|---|---|
| 1 | Walk-in order | customer created; price = engine trace; tax correct; payment recorded; receipt rendered with order#; labels generated; ledger balanced |
| 2 | Production | scan resolves order; instructions shown; stage changes create events with actor/branch/time; QC submit |
| 3 | Quality failure | reject needs reason; routed to configured stage; rework_count++; events; manager alert if over threshold |
| 4 | Pickup/delivery | booking in zone → fee; driver sees only own task; proof photo + OTP; wrong OTP rejected; driver pay calc recorded & independent of fee |
| 5 | Commercial | contract price applied; recurring order; consolidated invoice immutable; statement matches AR |
| 6 | Financial accuracy | multi-payment, deposit, partial refund, adjustment: AR, tax payable, cash, revenue reconcile to golden file and independent calc |
| 7 | Multi-branch | owner consolidated = Σ branches; manager sees only branch; direct API with other branch id denied |
| 8 | Tenant isolation | two tenants; exhaustive cross-access matrix all denied incl. files, search, exports, SSE, jobs |
| 9 | Entitlements | exceed seat/branch limit → blocked creation with code; existing data intact; upgrade unblocks; downgrade path |
| 10 | DR | restore DB + S3 into clean env; row counts/checksums, ledger balance, file hashes, login works |

## 3. Additional mandatory suites
Concurrent order updates (optimistic lock; two stage-advances racing) · duplicate webhooks & out-of-order events · duplicate payment submissions (same idempotency key; different key same cart warning) · cancelled orders with payments · failed payments · time-zone & DST boundaries (business-date cutoffs, promised times, Edmonton/Toronto) · permission escalation attempts (self-role edit, over-limit approval, self-approval) · tax calculation matrix (inclusive/exclusive, multi-component, zero-rated, rounding) · stock discrepancy/negative stock · notification failure & retry visibility · integration outage (circuit breaker, queued retries, user-facing status) · SSE reconnect · offline queue replay idempotency · file upload abuse · RLS-bypass attempts (SQL via crafted inputs, `SET` injection, role misuse) · migration up/down on populated DB · config-change-does-not-rewrite-history.

## 4. Data & environments
Deterministic seed factories (no production data in tests; demo tenants flagged `is_demo`); ephemeral DB per test worker; fake providers by default; sandbox accounts only in nightly. Production dashboards never read seed/demo data (guard: tenant `is_demo` excluded from platform analytics; UI badge).

## 5. Definition of Done (per feature)
Working UI + API + persistence + validation + authz + error handling + audit (if privileged) + migration + tests (unit/integration/E2E where applicable, tenant-isolation coverage) + docs updated + a11y checked + metrics instrumented + entitlement hook (if gated). No placeholders; no decorative controls.

## 6. CI/CD
GitHub Actions: lint/typecheck → unit → integration (services) → isolation suite → build → E2E (sharded) → security scans → container build → deploy staging → smoke → manual gate → prod (rolling) → post-deploy verification. Required checks block merge. Migrations tested on a restored copy of staging schema.
