# 03 — Navigation & Screen Inventory

Surface key: **A** admin/owner (desktop) · **S** staff/ops (tablet/desktop PWA) · **P** POS · **D** driver PWA · **C** customer portal · **W** public storefront · **X** platform console.
Tier: L / P1 / F as in 02.

## A. Business admin (`apps/web`, desktop-first)
Sidebar groups:

1. **Overview** — Executive dashboard (P1; L = daily ops summary) · Alerts (P1)
2. **Orders** — Order list (L) · Order detail (L) · Rework & exceptions (P1)
3. **Customers** — List/search (L) · Profile (L) · Segments (P1) · Complaints (P1) · Loyalty & promotions (P1)
4. **Commercial** — Accounts · Contracts · Recurring orders · Statements (P1)
5. **Operations** — Production board (L, S too) · Delivery/dispatch (P1) · Self-service machines (P1)
6. **Catalogue** — Services · Categories · Price lists · Price rules (L / P1)
7. **Finance** — Payments (L) · Cash shifts (L) · Invoices (P1) · Refunds (P1) · Expenses · Supplier bills · Ledger viewer · Reconciliation · Tax report (P1)
8. **Inventory** — Items · Suppliers · Purchase orders · Receipts · Stock movements · Counts (P1)
9. **Equipment** — Machines · Maintenance schedule · Work orders · Downtime (P1)
10. **People** — Employees (L) · Roles & permissions (L) · Shifts · Attendance · Leave · Commissions (P1)
11. **Reports** — Report library · Saved reports · Exports (P1)
12. **Settings** — Business profile (L) · Branches (L) · Tax (L) · Hours/holidays (L) · Workflows (L) · Delivery zones/fees (P1) · Driver pay (P1) · Notifications (P1) · Templates (receipt/invoice/label) (L) · Approval limits (L) · Website (P1) · Integrations (P1) · Billing & plan (P1) · Audit log (L) · Data export (P1)

## P. POS (full-screen, keyboard-first)
POS home (L) · Customer lookup/create (L) · Service picker (L) · Cart/order builder (L) · Payment (L) · Receipt & labels (L) · Open/close shift (L) · Refund request (P1) · Park/recall order (L).

## S. Staff operations (tablet/kiosk)
Scan (global) (L) · Task queue by role (L) · Order card (L) · Intake inspection (L) · Stage action (L) · QC inspection (L) · Rework (L) · Packaging/rack assign (L) · Handover/collection (L) · My shift/clock (L) · Inventory quick-count (P1) · Report breakdown (P1).

## D. Driver PWA
Today (jobs list/route) (P1) · Job detail · Navigate (deep link to maps) · Collect proof · Deliver proof (OTP/photo/signature) · Failed/reschedule · Earnings · Performance · Profile (P1).

## C. Customer portal
Sign up/in · Home (active orders) · Book pickup/delivery · Services & prices · Order tracking · History · Invoices & receipts · Pay · Addresses · Profile & consents · Loyalty/referrals · Support/complaint · (B2B) Account balance, recurring orders, invoices, users (P1).

## W. Storefront (SSR)
Home · Services & pricing · Locations & hours · Delivery areas · Book online · About/contact · Promotions · Legal pages (P1). Template chooser + theme editor lives in Admin → Settings → Website.

## X. Platform console (separate app)
Tenants (list/detail/status) · Plans & pricing · Entitlements & feature flags · Subscriptions & billing events · Usage · Support tickets · Support access grants & sessions · Announcements · Integration health · Security events · System health · Platform analytics · Config (P1; minimal tenant-admin & plan tooling in L via CLI/seeds).

## Global components
Command palette (Ctrl-K) · Global scan input · Notification center · Branch switcher · Tenant/user menu · Audit trail drawer on any entity · Empty/loading/error states.

## Screen count estimate
Admin ≈ 70 · POS 9 · Staff 12 · Driver 9 · Portal 15 · Storefront 8 · Platform 14 ≈ **137 screens**; launch ≈ **45**.
