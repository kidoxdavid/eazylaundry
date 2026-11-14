# 02 — Functional Requirements by Module

Tier legend: **L** = Launch (design-partner release, Phases 1–2 + thin slices) · **P1** = first public SaaS release (Phases 3–6) · **F** = Future (Phases 7+).
Every requirement implies: backend authz, validation, persistence, audit where privileged, automated tests.

## M01 Platform foundation (L)
- Tenant registration; organization & branch CRUD; branch settings.
- Auth: email+password (Argon2id), sessions (httpOnly cookies, rotation), TOTP MFA (L), password reset, device list.
- Roles, permissions, memberships; branch-scoped grants; permission-escalation guards.
- Audit log (append-only), request correlation IDs.
- Config engine: global default → tenant → branch overrides; versioned (L).
- File storage service (S3), signed URLs, virus-scan hook.

## M02 Customers & CRM
- L: Customer CRUD, search (phone/email/name/barcode), addresses, preferences, notes, consents, guest customers, duplicate detection, tags.
- P1: Segments (new/returning/high-value/inactive/at-risk), loyalty points, referrals, promotions, marketing consent & unsubscribe, complaints.
- F: Retention campaigns, CLV modelling, churn scoring.

## M03 Service catalogue & pricing
- L: Categories, services, pricing models (per-kg, per-item, bundle/package, fixed, express surcharge), price lists with effective dates, per-branch override, minimum charge, tax category.
- L: Price snapshot on order lines (historical orders never recomputed).
- P1: Customer-specific and contract prices; price rules (time/segment/volume).
- Pricing is computed by **one backend pricing engine** (no duplicate logic in clients).

## M04 POS & orders
- L: Order create/edit-before-processing, multi-service lines, weight/qty, instructions, discounts (with approval thresholds), taxes, delivery charge, order number sequence per branch, cancel (with reason), split/partial/deposit payment, receipt (print/email), labels.
- L: Cash drawer: open/close shift, cash in/out, count & variance.
- L: Idempotent submissions; optimistic concurrency on order updates.
- P1: Refunds & adjustments with approvals; order amendments after intake (supplement orders).

## M05 Intake & inspection
- L: Garment/bag-level capture (configurable per service): category, qty, weight, colour, fabric, care label, existing damage/stains (+photos), customer declarations.
- L: Immutable intake snapshot; discrepancy notes; customer acknowledgement (optional signature).
- P1: Garment-level IDs for dry-cleaning, special care, stain treatment tickets.

## M06 Production & workflow engine
- L: Workflow definitions per service type; stages with sequence, required roles, required actions/checklists, expected duration, approval gates; default 13-stage flow (07).
- L: Transition API validates allowed transitions + role; emits `order_event`; SLA deadline calc.
- L: Production boards (by stage, overdue, rework), work assignments, QC with reject/rework.
- P1: Exceptions (missing/damaged items, wrong quantity, complaints) with resolution flows; automatic notifications.
- F: Machine-aware scheduling suggestions.

## M07 Barcode & labels
- L: Unique order/bag/garment/package/rack IDs (Code128 + QR); label templates (HTML→PDF, ZPL option); scan endpoint returning authorized order card + next actions.
- Scanner = HID keyboard wedge; camera scanning in PWA.

## M08 Pickup, dispatch & delivery
- L (thin): Manual pickup/delivery tasks on an order assigned to staff.
- P1: Customer booking, recurring bookings, zones (polygon/postal prefix/distance), fee rules, driver app, dispatch board, route planning via map-provider abstraction, proof (photo, signature, OTP), failed/reschedule, driver compensation models (fixed/km/zone/%/hybrid) stored independently from customer fees with calculation records.

## M09 Customer portal & storefront (P1)
- Portal: register/login, profile, addresses, catalogue, booking, pay, track, history, invoices, notifications, loyalty, support.
- Storefront (SSR): branding, templates, SEO, custom domains (verified DNS + managed TLS), online booking.

## M10 Commercial accounts (P1)
- Account profiles & contacts, contract pricing, recurring orders, PO refs, credit limits, terms, consolidated invoices, statements, renewal alerts, SLA tracking, B2B portal roles.

## M11 Finance
- L: Payments (cash, card-external, manual methods), allocations, deposits, balance due, daily cash reconciliation, tax reporting by period.
- P1: Online payments (Stripe), refunds linked to original payment, invoices, immutable double-entry ledger, expenses, supplier bills, AR aging, payment reconciliation, branch/service profitability.
- F: Budgeting, forecasting, accounting-platform sync.

## M12 Inventory & procurement (P1)
Items, suppliers, POs, goods receipt, movements, transfers, adjustments, reorder thresholds, valuation (weighted average default), consumption (per service standard usage), waste, batch/expiry, low-stock alerts.

## M13 Equipment & maintenance (P1)
Machine register, status, capacity, warranty, preventive schedules, work orders, downtime, repair cost, utilization (from sessions), reporting. Controller integrations F.

## M14 Self-service laundromat (P1/F)
Machine register (shared with M13), manual session recording (start/stop, payment), occupancy, revenue per machine. Booking and controller/payment-terminal integrations F per vendor.

## M15 Workforce (L basic / P1)
- L: Employees, roles, branch assignment, clock in/out, task assignment, activity log.
- P1: Shifts, leave, productivity, commissions/incentives, payroll export.

## M16 Notifications
- L: Email (provider abstraction), in-app. P1: SMS, templates per tenant, triggers from workflow events, consent-aware, delivery log, retries, failure surfaced.

## M17 Reporting & BI (P1)
Metric registry (each metric has definition, SQL, owner, grain, tests) → dashboards, filters, comparisons, drill-down, CSV/XLSX export, saved reports, targets. L has an **operational daily summary** only.

## M18 Intelligence (F)
Rule-based alerts first (backlog, deadline risk, stock anomalies), forecasting, then AI assistant using tool-calling over the metric registry; read-only by default; any write requires human confirmation + permission.

## M19 SaaS commercialization (P1)
Plans, entitlements, trials, Stripe Billing, lifecycle (upgrade/downgrade/cancel/dunning/grace), usage tracking, onboarding wizard, platform console, support grants, feature flags, announcements.

## M20 Integrations (cross-cutting)
Provider interfaces, encrypted credentials, webhook verification & idempotency, connection test, retry/backoff, integration logs, status.

## M21 Governance & data (L/P1)
Audit viewer, data export (tenant & customer DSAR), retention policies, tenant offboarding, backup/restore runbooks.

## Launch scope (design-partner release) — summary
M01, M02(L), M03(L), M04(L), M05(L), M06(L), M07(L), M08(thin), M11(L), M15(basic), M16(email/in-app), operational daily summary. Everything else is P1/F.

## Dependencies
M01 → everything · M03 → M04 → M05/M06 → M07 · M04 → M11 · M06 → M16 · M08 needs M04+M06 · M10 needs M03+M11 · M17 needs stable M04/M11 data · M19 needs M01 entitlements hooks (instrumented from the start).
