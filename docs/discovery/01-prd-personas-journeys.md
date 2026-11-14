# 01 — Product Requirements, Personas, Journeys

## 1. Product summary
EazyLaundry is a multi-tenant SaaS operating system for laundry businesses (full-service, wash-and-fold, dry cleaning, pickup/delivery, self-service, commercial). It is sold by subscription and also run by Eazy Group on its own laundry operation as tenant #1.

## 2. Goals and non-goals

**Goals**
- G1. One platform runs an end-to-end laundry operation: intake → production → QC → delivery/collection → payment → reporting.
- G2. Strict tenant isolation (DB RLS + service authz + tests).
- G3. Auditable, immutable financial records; no floats for money.
- G4. Owner-configurable pricing, workflows, tax, delivery, permissions without developers.
- G5. Operable by floor staff: scanner-first, few clicks, tablet friendly.
- G6. Commercially viable: self-serve subscription with entitlements.

**Non-goals (launch)**
- Payroll processing (exports only). Replacement of certified accounting software. Remote machine control (manual sessions only). Native iOS/Android apps. Healthcare-regulated laundry. Marketplace/aggregator (cross-tenant customer discovery). Microservices.

## 3. Success metrics (hypotheses to validate)
| Metric | Target |
|---|---|
| Walk-in order creation time (existing customer, 1 service) | ≤ 45 s |
| Scan-to-action latency (p95) | < 400 ms |
| Tenant isolation test suite | 100 % pass, gating CI |
| Design-partner weekly active staff | ≥ 80 % of staff in 30 days |
| Trial → paid conversion | ≥ 20 % (to be validated) |
| Cash drawer variance unexplained | < 0.5 % of cash sales |

## 4. Personas

| Persona | Context | Needs | Primary surface |
|---|---|---|---|
| **Owner (Priya)** – runs 3 branches | Office + phone | Profit truth, branch comparison, control of discounts/refunds | Admin dashboard |
| **Branch manager (Marcus)** | On floor, tablet | Overdue orders, staffing, approvals, cash close | Staff app / admin |
| **Cashier (Aisha)** | Counter, scanner, thermal printer | Fast customer lookup, accurate totals, receipt | POS |
| **Laundry tech (Luis)** | Wet floor, gloves, shared tablet | Scan bag, see instructions, advance stage | Staff app (kiosk mode) |
| **Quality inspector (Dana)** | Packing area | Checklist, pass/fail, route to rework | Staff app |
| **Driver (Sam)** | Vehicle, one hand | Today's jobs, navigate, proof, earnings | Driver PWA |
| **Retail customer (Jordan)** | Phone | Book pickup, price clarity, tracking, pay | Portal / storefront |
| **Commercial buyer (Hotel housekeeping lead)** | Office | Recurring orders, invoices, balance | Portal (B2B) |
| **Finance clerk (Lee)** | Office | Reconciliation, invoices, exports | Admin |
| **Platform admin (Eazy Group SaaS ops)** | Separate console | Tenants, plans, health, support | Platform admin |
| **Platform support agent** | Console | Time-boxed, consented access to debug | Platform admin |

## 5. Business-model personas (tenants)
Single laundromat · wash-fold shop · pickup/delivery laundry · dry cleaner · multi-branch operator · commercial laundry · enterprise. Capabilities are enabled per tenant through **modules** (09).

## 6. Key user journeys

**J1 Walk-in order (Aisha).** Search/scan customer → (or create/guest) → pick branch (defaulted) → add service(s) → enter weight/qty → garments & notes (optional by service config) → price engine returns itemized quote → apply authorized discount → tax auto → payment (cash/card/split/deposit) → order# + labels + receipt.

**J2 Production (Luis).** Scan bag label → order card (instructions, flags, current stage, next action) → "Start washing" (assign machine optional) → complete → next stage. Each transition writes an immutable `order_event`.

**J3 Quality failure (Dana).** Scan → QC checklist → Reject → reason code + photo → rework stage selected (default per reason) → order returns to stage, rework count++, manager notified if SLA at risk.

**J4 Pickup & delivery (Jordan/Sam).** Customer books slot (address in zone; fee shown) → dispatcher assigns driver (or auto-suggest) → Sam collects (photo, bag count, signature) → hub intake → production → ready → delivery booked/assigned → OTP + photo → completed; driver pay computed.

**J5 Commercial account.** Account created with contract price list, PO reference, terms → recurring pickup schedule → orders priced via contract → month-end consolidated invoice → statement → payments allocated to invoices.

**J6 Refund (Marcus).** Cashier requests refund → exceeds threshold → approval request → manager approves → refund posted against original payment; reversal ledger entries; audit event.

**J7 Owner morning check (Priya).** Dashboard: yesterday vs last week, overdue orders, cash variance, low stock, AR aging → drill into a branch.

**J8 Tenant onboarding (SaaS).** Sign-up → trial plan → create org, branch, tax jurisdiction defaults (Alberta GST) → import services → invite staff → connect Stripe → go live checklist.

**J9 Support access.** Tenant owner grants a 2-hour, scope-limited support grant → agent accesses with banner + full audit → grant expires or is revoked.

## 7. Cross-cutting requirements
Security & privacy (06) · Accessibility WCAG 2.2 AA · i18n-ready · idempotency · audit logging for all privileged actions · export of tenant data · observable and testable (11).

## 8. Assumptions to validate with design partners
1. Retail wash-and-fold is weighed at intake and re-weighed after drying only by exception.
2. Dry-cleaning customers expect garment-level tracking; wash-and-fold customers don't.
3. Subscribers will accept Stripe Connect onboarding.
4. $49–$179 CAD/month is within willingness to pay for target segments (no evidence yet).
5. Most small shops already own a barcode/thermal printer or will buy a recommended model.
