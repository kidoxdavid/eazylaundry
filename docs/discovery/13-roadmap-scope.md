# 13 — Implementation Roadmap & Initial Development Scope

Durations are planning estimates for a small senior team (≈4–6 engineers + designer), to be re-baselined after Phase 1. They are not commitments.

## 1. Phases with exit criteria

| Phase | Content | Est. | Exit gate (all must pass) |
|---|---|---|---|
| **0 Discovery** | This pack, decisions D1–D5 | 2 wk | Sign-off |
| **1 Foundation** | Monorepo, CI, Docker dev env, Drizzle migrations, auth (+MFA), tenants/orgs/branches, users/roles/permissions/memberships, config engine v1, audit log, file service, entitlement hooks (no-op), design system v0, RLS + **isolation test suite** | 6–8 wk | Isolation suite 100 % in CI; catalog RLS check; permission-escalation tests; deploy to staging |
| **2 Core operations (launch)** | Customers, catalogue & price lists, pricing/tax engine, POS, orders, intake/inspection, labels/scan, workflow engine, production boards, QC/rework, collection/handover, payments (cash + manual card), cash shifts, receipts, basic notifications, daily ops summary, staff basics (clock-in) | 10–12 wk | Tests 1–3 pass; usability test on POS; Eazy Group pilot branch live (shadow then primary) |
| **3 Customer & logistics** | Portal, storefront (SSR) + templates, bookings, zones/fees, dispatch, driver PWA, proof of delivery, driver pay, Stripe online payments, SMS | 10–12 wk | Test 4; payments verified in live mode with test merchant |
| **4 Finance & management** | Ledger, refunds/approvals, invoicing, expenses/AP, AR, reconciliation, inventory & procurement, equipment & maintenance, commercial accounts, shifts/leave/commission | 12–14 wk | Tests 5, 6, 7; ledger integrity job clean for 30 days of pilot data |
| **5 BI** | Metric registry, dashboards, branch/customer/equipment analytics, saved reports, exports, targets | 6–8 wk | Every metric documented + reconciled against source; export tests |
| **6 SaaS commercialization** | Plans, Stripe Billing, entitlements enforcement, trials, onboarding wizard, platform console, support grants, usage | 6–8 wk | Test 9; billing lifecycle E2E; legal docs |
| **7 Advanced intelligence** | Alerts, forecasting, AI assistant, retention/inventory intelligence | 6–8 wk | AI answers match metric registry in eval set; no unauthorized writes |
| **8 Production readiness** | Hardening, pen-test, perf tests, DR drills, monitoring/on-call, a11y audit, docs, GA | 4–6 wk | Test 10; pen-test findings closed; perf targets met; public launch checklist |

Note: Phases 5/6 can overlap with 4 given staffing; **public SaaS availability is after Phase 6 + critical parts of 8 (pen-test, DR)**. The Eazy Group pilot starts at end of Phase 2.

## 2. Launch scope vs later

**Essential for first operational launch (Eazy Group pilot, end of Phase 2):** tenant/branch/staff/roles; customers; services/pricing/tax; POS with split/deposit payments and cash shifts; intake with photos; labels & scanning; configurable workflow with QC & rework; production board; handover; receipts; audit; daily summary; data export (CSV); backups.

**First public release (P1):** customer portal/storefront, bookings, delivery & driver app, online payments, refunds/approvals, invoicing & commercial accounts, ledger & expenses, inventory, equipment, BI v1, billing & entitlements, platform console.

**Later (F):** AI assistant & forecasting, machine controller integrations, self-service booking, accounting sync, native apps, WebAuthn, enterprise DB isolation, additional payment providers, fr-CA content, marketplace features.

## 3. Initial dev scope (Phase 1 backlog, priority order)
1. Repo + tooling: pnpm/Turborepo, TS strict, ESLint/Prettier, commit hooks, dependency-cruiser boundaries, GitHub Actions skeleton, docker-compose (Postgres 16, Redis, MinIO, Mailpit).
2. DB foundation: roles (`app_owner`, `app_rw`, `app_platform`), migration runner, UUIDv7, RLS helper SQL, catalog tests, audit/outbox/idempotency tables.
3. Tenancy core: tenants/organizations/branches, tenant registration flow, tenant-context transaction wrapper (`withTenant`), RLS on all.
4. Identity: users, sessions, Argon2id, login/logout, password reset, TOTP MFA, rate limiting, CSRF.
5. Authorization: permissions catalogue, role templates, memberships, branch scope, limits, `AuthorizationService`, anti-escalation rules.
6. Config engine v1 (global→tenant→branch, versioned).
7. Audit logging + viewer API.
8. **Isolation test harness** (route enumeration from OpenAPI + DB-level tests) — before any business feature.
9. Web shell: design tokens, UI package v0, auth screens, tenant onboarding, branch/user/role admin screens, nav, i18n scaffolding.
10. OpenAPI generation, typed client, error model (RFC 7807), correlation IDs, logging/OTel.
11. Staging deploy (Terraform baseline), seed & demo tenant tooling.
12. Docs: ADRs, ERD generated from schema, security doc, runbooks skeleton, **PROJECT_STATUS.md** upkeep.

## 4. Dependencies & critical path
Auth/tenancy → permissions → config → catalogue/pricing → orders → workflow → payments → ledger → reporting. Longest-lead external items to start early: Stripe Connect account & platform review, domain & email deliverability (SPF/DKIM/DMARC), Google Maps billing account, legal docs (ToS/DPA/Privacy) drafting, design-partner recruitment, thermal printer/scanner reference hardware purchase, AWS org & accounts.

## 5. ADR log (decisions taken by default; see also 04 §4)
| ADR | Decision | Reason |
|---|---|---|
| 012 | Order numbering `BRANCHCODE-YYMM-NNNNN` via per-branch locked counter | Human-readable, no cross-tenant guessability beyond tenant; barcode encodes opaque token, not the number |
| 013 | Barcode payload = opaque short token (+checksum) mapped server-side | Prevents enumeration; reprint safe |
| 014 | Config as append-versioned rows with effective dates | Audit, rollback, no history rewrite |
| 015 | Workflow definition version pinned per order | Stable in-flight orders |
| 016 | Event-sourced *history* (order_events) but state-based aggregates | Auditability without ES complexity |
| 017 | i18n via ICU message format, en-CA default | Quebec expansion |
| 018 | Weights stored in grams, display in kg/lb | Avoid unit bugs |
| 019 | Customers tenant-scoped (C3) | Privacy by construction |
| 020 | No SIN or raw card data collected | Minimise breach impact |

## 6. Review checklist for you
- [ ] D1–D5 decisions (00)
- [ ] Conflict resolutions C1–C10 acceptable
- [ ] Launch scope (§2) matches your commercial priorities
- [ ] Plan matrix & pricing hypotheses (09) acceptable as placeholders
- [ ] Anything missing for Eazy Group's own operation (e.g., specific branches, existing hardware, current systems to migrate)
