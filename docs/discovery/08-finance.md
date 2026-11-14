# 08 — Financial Architecture and Calculations

**Scope statement (D4):** EazyLaundry maintains an immutable, balanced **operational double-entry ledger** and produces accounting exports. It is not certified accounting software and does not file taxes. Tax reports are aids for the tenant's accountant.

## 1. Principles
1. Integer minor units + currency everywhere (`bigint`, `char(3)`); single `money` package (add/sub/allocate/round) used by backend only. Clients display, never compute totals.
2. One pricing/tax calculation service; its **full trace** (rule ids, versions, rates, rounding) is stored on each order line.
3. Posted ledger data is **append-only**. Corrections = reversal + new posting, linked (`reverses_id`).
4. Every posting is balanced (deferred constraint trigger: Σdebits = Σcredits per transaction & currency).
5. All money-moving endpoints are idempotent (`Idempotency-Key`), concurrency-safe (row locks/serializable where needed).
6. Historical orders are never repriced by config changes (snapshots).
7. Multi-currency: one currency per tenant at launch (CAD default); schema stores currency on every amount to allow later expansion; cross-currency postings rejected.

## 2. Rounding & tax
- Line tax = round-half-up (configurable per jurisdiction) of `taxable_amount × rate` at **line level or invoice level** per tax-jurisdiction setting (default: line level, summed). Rounding differences allocated to the last line (largest-remainder allocation) so totals equal sum of parts.
- Tax rates effective-dated; tax category per service (taxable, zero-rated, exempt). Seed: Alberta GST 5 %. HST/PST/QST via additional jurisdictions & multi-component taxes (`tax_rates` many per jurisdiction, compounding flag).
- Tax-inclusive vs exclusive pricing is a tenant setting.
- Discount ordering: line discounts → order discounts (pro-rated to lines) → tax → delivery fee (taxable per rule) → total.

## 3. Definitions (every metric documented; implemented in the metric registry)

| Term | Definition |
|---|---|
| **Gross order value** | Σ line list totals + delivery/surcharges, before discounts and tax |
| **Discounts** | Σ line and order discounts applied (positive number) |
| **Net sales** | Gross order value − Discounts (excluding tax) |
| **Tax collected/payable** | Σ tax on completed (revenue-recognized) orders, less tax on credit notes/refunds |
| **Order total** | Net sales + tax |
| **Cash received** | Σ settled payments (by `received_at` business date), all methods, excluding customer-deposit **liability** until applied |
| **Refunds** | Σ completed refunds (by refund date), linked to original payment |
| **Recognized revenue** | Net sales of orders reaching revenue-recognition event (default: handover/`completed`; per-tenant policy: `at_intake | at_ready | at_handover`), less credit notes/adjustments, by recognition business date |
| **Deposits / customer credits** | Liability = payments received − allocations to recognized/due amounts |
| **Outstanding receivable (AR)** | Σ(invoice or order total recognized/billed) − Σ allocations − credit notes, for open items |
| **Cost of services** | Direct costs: consumables consumed (inventory valuation × standard usage or actual), direct labour (if enabled via workforce cost rates), driver pay, machine repair/maintenance (allocated) — each source labelled "measured" or "estimated" |
| **Gross profit** | Recognized revenue − Cost of services |
| **Operating expenses** | Σ expenses/supplier bills by accrual date (rent, utilities, wages not already in COS…) |
| **Net profit (operating)** | Gross profit − Operating expenses (excludes income tax, interest unless recorded) |
| **Average order value** | Net sales ÷ count of completed orders in period |
| **Branch profitability** | Same formulas filtered by `branch_id`; shared expenses allocated only via explicit tenant-defined allocation rules (else shown as "unallocated") |
| **Customer lifetime value** | Σ recognized net revenue per customer over history (historical); predicted CLV (F) is labelled "estimate" |

Dashboards state basis (accrual vs cash) next to every figure; "profit" is never shown if cost data is incomplete without a data-quality warning.

## 4. Ledger chart (default, tenant-editable codes)
Assets: Cash on hand (per drawer), Bank/Clearing – card processor, Accounts receivable, Inventory. Liabilities: Customer deposits & credits, Sales tax payable, Driver/commission payable, Accounts payable, Gift cards/loyalty liability (F). Revenue: Sales – by service category, Delivery revenue, Discounts (contra), Refunds & returns (contra). Expenses: COGS-supplies, Delivery driver pay, Repairs & maintenance, Utilities, Rent, Payroll (external), Processor fees, etc. Equity/Retained (for export mapping).

## 5. Posting rules (event → entries)

| Event | Debit | Credit |
|---|---|---|
| Deposit/payment received before recognition | Cash / Processor clearing | Customer deposits |
| Order recognized (at handover) | AR **or** Customer deposits (applied) | Sales (by category); Delivery revenue; Sales tax payable |
| Payment received against recognized order | Cash / Clearing | AR |
| Discount | Discounts (contra) — recorded gross on lines | |
| Refund to card | Refunds & returns (+ tax payable reversal) | Clearing / Cash |
| Processor fee (from payout report) | Processor fees | Clearing |
| Invoice issued (commercial) | AR | Sales + Tax payable |
| Credit note | Sales/Refunds contra + tax payable | AR |
| Expense / supplier bill | Expense or Inventory; | AP |
| Bill payment | AP | Cash/Bank |
| Cash variance at shift close | Cash over/short | Cash on hand |
| Driver pay (accrued on job completion) | Driver pay expense | Driver payable |

Postings occur in the **same DB transaction** as the business event (or via outbox if cross-module with guaranteed delivery + reconciliation check). A nightly **ledger integrity job** verifies: (a) all transactions balanced, (b) `orders.balance_due` equals ledger-derived AR/deposits, (c) payments allocated ≤ payment amount, (d) cash shift totals — discrepancies raise alerts, never silent fixes.

## 6. Payments, allocations, refunds
- `payments` (what money arrived) and `payment_allocations` (what it settled) are separate; one payment can span orders/invoices, one order can have many payments.
- Over-payment → customer credit; under-payment → balance due.
- Refund requires `payment_id` + amount ≤ unrefunded remainder; method defaults to original; threshold approval; provider refund called with idempotency key; ledger posts only on provider success (state machine `requested → approved → processing → completed | failed`).
- Failed payments never post revenue; "payment pending" is its own state. Duplicate webhook → deduped by `webhook_events(provider,event_id)`.
- Cash: shift open (float) → cash sales/refunds/pay-ins/outs → close with counted cash → variance posted, approval above tolerance.
- Adjustments post-completion create `order_adjustments` + credit note/supplement entries; originals untouched.

## 7. Invoicing (P1)
Commercial accounts: monthly consolidated invoice generated from completed uninvoiced orders (period + cut-off by business date), numbered sequentially per tenant (gap-free sequence table with locking), immutable once issued; statements derived; terms (net 15/30), credit limit warnings/blocks, late-fee policy (configurable), PDF generation, e-delivery.

## 8. Reconciliation
Payment reconciliation: provider payouts/balance transactions ↔ `payments`/refunds/fees; unmatched items queue. Cash reconciliation: shift counts ↔ ledger. Report: daily close pack (sales, tax, tenders, variance).

## 9. Test oracles (Test 6)
Golden-file scenarios: multi-payment + partial refund + tax rounding on mixed lines + adjustment + deposit-then-recognition; property-based tests (Σ allocation = payment; ledger balances; refunds ≤ paid; rounding allocation sums). A parallel independent calculation in the test suite (decimal.js) cross-checks the production engine.
