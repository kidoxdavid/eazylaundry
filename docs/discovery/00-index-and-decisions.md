# EazyLaundry — Discovery Pack (Phase 0)

Status: **Draft for review** · Date: 2026-11-14 · No code has been written.

## Reading order

| # | Document | Covers deliverables |
|---|----------|---------------------|
| 00 | This file | Decisions needing your sign-off, conflicts, omissions |
| 01 | [PRD, personas, journeys](01-prd-personas-journeys.md) | 1, 3 |
| 02 | [Functional requirements by module](02-functional-requirements.md) | 2, 20 (launch tiers) |
| 03 | [Navigation & screen inventory](03-navigation-screens.md) | 4 |
| 04 | [System, integration & deployment architecture](04-architecture.md) | 5, 14, 16 |
| 05 | [Database ERD & schema](05-database.md) | 6, 7 |
| 06 | [Tenant security, permission matrix, threats](06-security-tenancy.md) | 8, 9 |
| 07 | [Production workflows](07-workflows.md) | 10 |
| 08 | [Financial architecture](08-finance.md) | 11 |
| 09 | [SaaS subscriptions & entitlements](09-saas-entitlements.md) | 12 |
| 10 | [UX/UI specification](10-ux-spec.md) | 13 |
| 11 | [Testing strategy](11-testing-strategy.md) | 15 |
| 12 | [Risks & commercialization](12-risks-commercialization.md) | 17, 18 |
| 13 | [Roadmap & initial scope](13-roadmap-scope.md) | 19, 20 |

## The five decisions I need from you (material)

Everything else I will decide by default (recorded in ADRs in 13).

### D1. Launch strategy: dogfood first, then SaaS
- **Why it matters:** The brief is ~35 modules. Building all before first revenue is the main project risk.
- **Options:** (a) Build everything, launch SaaS; (b) **Build for Eazy Group's own laundry first (as tenant #1 on the real multi-tenant platform), onboard 3–5 design-partner subscribers, then open self-serve SaaS**; (c) SaaS-only, no own ops.
- **Recommendation: (b).** Real operations expose real defects; Eazy Group is a free, honest design partner. Multi-tenancy is built from day one (not retrofitted), but billing/self-serve onboarding is deferred to Phase 6.
- **Implication:** Launch scope = Phases 1–2 + thin slices of 3 and 4 (see 13).

### D2. Payments model for subscribers' customer payments
- **Why:** Determines PCI scope, regulatory exposure (money transmission), and who holds funds.
- **Options:** (a) **Stripe Connect (Standard/Express) — each tenant is its own merchant; Eazy never holds funds**; (b) Eazy as master merchant, pays tenants out (heavy regulatory/liability); (c) Tenant brings own gateway keys (Stripe/Helcim) — simplest, weaker UX, no application fee.
- **Recommendation: (a) with provider abstraction, (c) as an interim fallback, Helcim adapter later** (Helcim has no marketplace model comparable to Connect). Card data never touches our servers (hosted fields / Terminal).
- **Implication:** Tenant onboarding includes Stripe KYC. Eazy platform subscription billing uses Stripe Billing separately.

### D3. Storefront / customer portal rendering stack
- **Why:** The brief mandates React+Vite, but public storefronts need SEO, fast first paint, and custom domains with per-tenant theming. A Vite SPA is poor for that.
- **Options:** (a) All SPA (Vite); (b) **Vite SPA for authenticated apps (admin, staff/POS, driver, customer portal) + a separate SSR app (Next.js, React) for public storefronts**; (c) Everything in Next.js.
- **Recommendation: (b).** Keeps the mandated stack for 90% of the product and adds one SSR app where SEO is a real requirement. Shared `packages/ui`.

### D4. Ledger scope — operational sub-ledger, not a GL replacement
- **Why:** "Accounting" can mean building QuickBooks. That is a trap.
- **Recommendation:** Build an **immutable double-entry operational ledger** (AR, deposits/customer liabilities, sales, tax payable, cash/clearing, refunds, expenses) that is internally consistent and exportable, plus **QuickBooks Online / Xero export-then-sync** later. Do not claim to replace certified accounting software (per your rule 13). Details in 08.

### D5. Driver app: PWA first, native later
- **Why:** Continuous background GPS and push on iOS require native. Proof-of-delivery (camera, signature, OTP) works fine in a PWA.
- **Recommendation:** Mobile-first PWA (Phase 3) with no live-tracking claim; add Capacitor-wrapped native shell only if/when live tracking is validated as a paid need. Live location is shown **only** from real device pings.

## Conflicts & inconsistencies found in the brief (and resolutions)

| # | Conflict | Resolution |
|---|----------|-----------|
| C1 | `tenants` and `organizations` both listed | **One concept.** `tenants` = platform-level account (billing, status); `organizations` = 1:1 business profile inside it. Kept separate so a tenant could later own several legal entities. All tenant tables carry `tenant_id`. |
| C2 | Eazy Group as platform *and* operator | Eazy Group the **provider** is the platform org (no tenant data access). Eazy Group the **laundry operator** is an ordinary tenant ("Eazy Laundry Services"). Different identities, memberships, and audit streams. |
| C3 | `customers` for end-customers vs. cross-tenant login | Customers are **tenant-scoped records**. A person using two laundries has two customer records. A shared login identity (`auth_identities`) may link them but never exposes data across tenants. |
| C4 | `apps/web, api, customer, driver` + public storefront | Becomes `web` (admin+staff+POS), `portal` (customer), `driver`, `storefront` (SSR), `platform-admin`, `api`, `worker`. Platform admin is a **separate app and deployment** (brief §4.6). |
| C5 | "Never hardcode rules" vs. "Alberta defaults" | Defaults are **seed data** (tax jurisdiction rows), not code. |
| C6 | "Recognized revenue" undefined | Default: recognized at **order handover/completion**; deposits held as customer liability until then. Configurable policy per tenant (08). |
| C7 | "Free of arbitrary usage charges" vs. "usage records" | Usage is tracked for **entitlement limits** (branches, seats, orders/mo soft caps) not metered billing. |
| C8 | RLS plus ORM choice | Prisma makes per-request `SET LOCAL` and RLS awkward; **Drizzle + SQL-first migrations** chosen (ADR-003). |
| C9 | Healthcare laundry | Triggers HIA/PHIPA-type obligations. **Excluded from launch**; flagged as regulated vertical needing separate compliance review. |
| C10 | "Live machine connection" | Launch = manual machine session recording only. Controller integrations are Phase 8+ and per-vendor. |

## Omissions I am adding

1. **Offline tolerance** for intake/POS (laundries have flaky Wi-Fi): queued, idempotent submissions in the staff PWA.
2. **Idempotency keys** on every money/state-changing endpoint.
3. **Receipt/label hardware**: ESC/POS thermal printers, label printers (ZPL), barcode scanners as keyboard wedge — needs a defined print path (browser print + optional local print agent).
4. **Garment lost-and-found / unclaimed laundry policy** (abandoned item workflow, legal retention).
5. **Customer-claim & liability limits** (damage claims with configurable liability caps).
6. **Data residency**: AWS `ca-central-1` (Canadian customers' personal data).
7. **Tenant offboarding**: export, retention, deletion workflow.
8. **Time-zone model**: UTC timestamps + branch IANA time zone; business-date concept for financial cut-off.
9. **Localization** (en-CA, fr-CA — Quebec expansion needs French; scaffold i18n now).
10. **Support-access** (impersonation) model with customer consent + expiry (06).
11. **Accessibility target**: WCAG 2.2 AA.
12. **Observability budget**: logs, traces, error tracking, per-tenant SLO dashboards.

## What happens next
On your sign-off (or edits) of D1–D5, I begin Phase 1. I will not start before that.
