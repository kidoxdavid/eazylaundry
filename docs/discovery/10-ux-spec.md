# 10 — UX/UI Design Specification

## 1. Identity
Calm, precise, "instrument-panel" feel: confident neutrals with one saturated accent, dense-but-legible data, restrained motion. No stock admin template look: no gradient headers, no card-per-metric grids by default, no oversized hero type inside the app.

**Tokens (initial; to be tuned in design review)**
- Color: ink `#0F172A`, surface `#FFFFFF` / `#F6F7F9`, line `#E3E6EB`, accent (brand) deep teal `#0B6E6E`, accent-strong `#08504F`; semantic: success `#1E7F4F`, warning `#B7791F`, danger `#B42318`, info `#1D4ED8`. Dark theme as first-class token set. Tenant branding applies to **customer-facing** surfaces (storefront, portal, receipts) via tokens; staff apps keep platform identity.
- Type: Inter (UI), tabular figures for all numbers (`font-variant-numeric: tabular-nums`), scale 12/13/14/16/20/28; base 14 on desktop admin, 16 on POS/driver/customer.
- Spacing 4-pt grid; radius 6 (controls) / 10 (panels); elevation minimal (1 border + subtle shadow for overlays only).
- Contrast ≥ 4.5:1 text, ≥ 3:1 UI; focus ring always visible (2 px accent + offset); target size ≥ 44 px on touch surfaces (≥ 56 px kiosk/driver primary actions).

## 2. Component system (`packages/ui`)
Built on accessible primitives (Radix UI) + Tailwind. Inventory: Button (primary/secondary/ghost/danger, loading), IconButton, Input/Textarea/Select/Combobox (async), NumberInput (weight/money), DatePicker/TimeWindow, Checkbox/Radio/Switch, **DataTable** (virtualized, column pinning, saved views, bulk actions, keyboard nav, CSV export), Filters bar, Tabs, Dialog, Drawer, Popover, Toast, Banner, Badge/StatusPill (stage/colour + icon + text; never colour-only), Stepper, Timeline (order events), KeyValue lists, Money & Weight display, Barcode/QR, Scan input, Signature pad, Camera capture, Chart kit (line/bar/stacked/sparkline; tables as fallback), Empty/Loading (skeleton)/Error states, Command palette, Permission-aware wrappers (`<Can>` hides **and** server enforces).

## 3. Surface-specific experiences

| Surface | Form factor | Principles | Signature patterns |
|---|---|---|---|
| **Owner/admin** | Desktop 1280+ | Scannable, drill-down, comparisons | Left nav, global filter bar (date/branch/service/segment), KPI strip with period delta + definition tooltip, tables first, charts only where trend matters |
| **POS** | Desktop/tablet landscape, keyboard + scanner | ≤ 45 s walk-in; no page navigation | 3-pane: customer & instructions · service/item picker with quick keys · live itemized total & tender; F-keys; persistent order parking; large totals; error prevention (can't submit while required fields missing) |
| **Staff ops** | 10–11" tablet, gloves, shared device | Scan first; one primary action per screen | Always-focused scan field; order card with giant stage action; role-filtered queue; PIN switch; minimum text entry |
| **Production board** | Wall display / tablet | See problems in 3 seconds | Columns per stage, aging badges (on-time / at risk / overdue), counts reconcile with list, SSE live, colorblind-safe palette + icons |
| **Driver** | Phone portrait, one-hand | Thumb zone; offline-tolerant | Bottom action bar, today list ordered by route, big "Navigate"/"Arrived"/"Done", proof capture steps (photo → OTP/signature), no hidden gestures |
| **Customer portal/storefront** | Mobile-first | Trust & clarity | Price shown before commitment, delivery fee transparent, simple 3-step booking, status timeline with real events only, secure payment cues, order-by-phone fallback |
| **Platform console** | Desktop | Safety | Strong environment/tenant context header, confirmation for destructive actions, audit side-panel |

## 4. States & feedback
Every screen defines: loading (skeleton), empty (with next action), partial/degraded, error (human message + retry + correlation id), permission-denied (explains who can grant), conflict (optimistic-lock: "updated by X — review"), offline (banner + queued indicator). Destructive/financial actions: summary-confirm dialog; undo where reversible; **never** a button that silently no-ops — buttons whose feature isn't entitled/enabled are hidden or show an explicit upgrade/disabled reason.

## 5. Accessibility (WCAG 2.2 AA)
Keyboard-complete flows (POS fully operable without a mouse), logical focus order & trapping in dialogs, ARIA via primitives, live regions for toasts/scan results, reduced-motion respect, text resize to 200 %, form errors associated and announced, no colour-only status, automated axe checks in CI + manual screen-reader pass per release (Phase 8 gate, but components built compliant from day 1).

## 6. Content & localization
Plain language, domain terms customisable per tenant (e.g., "Ticket" vs "Order"); i18n framework from start (en-CA now, fr-CA ready), Canadian formats (CAD $1,234.56; dates in tenant tz; kg/lb toggle; postal `A1A 1A1`), address autocomplete via map provider.

## 7. Information architecture rules
Max 2 nav levels; settings grouped by intent; every list has search + filters + saved views; every entity has an audit trail drawer; Ctrl-K and global scan available everywhere in staff apps.

## 8. Process
Design-partner usability tests on POS & ops flows (5 users/round) before Phase 2 exit; figures prototyped in Figma → tokens exported to `packages/ui`; Storybook for components with a11y addon; visual regression via Playwright.
