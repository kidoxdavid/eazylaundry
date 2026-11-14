# 12 — Risk Register & Commercialization Strategy

## A. Risk register
Likelihood (L) / Impact (I): 1–5. Score = L×I.

| ID | Risk | L | I | Score | Mitigation | Owner |
|---|---|---|---|---|---|---|
| R1 | **Scope overload** (35 modules) delays any revenue | 5 | 5 | 25 | Dogfood-first launch (D1); strict tiering; phase gates; defer F items | PM |
| R2 | Tenant data leak | 2 | 5 | 10 | RLS + tests + pen-test + no BYPASSRLS | Security |
| R3 | Financial miscalculation/ledger drift | 3 | 5 | 15 | Single engine, property tests, nightly integrity job, golden files | Finance arch |
| R4 | Payment-provider/KYC friction for subscribers | 3 | 4 | 12 | Connect onboarding UX; tenant-keys fallback; Helcim adapter | PM |
| R5 | Regulatory (PIPEDA/PIPA, CASL, PCI, tax) misinterpretation | 3 | 4 | 12 | Counsel review pre-GA; PCI SAQ-A scope via hosted fields; consent records; no certification claims | Legal |
| R6 | Wrong market assumptions (pricing, feature need) | 4 | 4 | 16 | Design partners, pricing tests, usage analytics, interviews before building P1 | Growth |
| R7 | Floor-staff adoption fails (UX, hardware, Wi-Fi) | 3 | 4 | 12 | On-site pilots, offline tolerance, hardware guide, kiosk mode, usability tests | UX |
| R8 | Hardware integration diversity (printers/scanners/machines) | 4 | 3 | 12 | Standard HID scanners, browser print; machine integrations deferred/per-vendor | Eng |
| R9 | Custom domain/TLS complexity & abuse | 3 | 3 | 9 | Use managed edge (CloudFront/Caddy), DNS verification, reserved slugs | DevOps |
| R10 | Key-person/team capacity vs ambition | 4 | 4 | 16 | Modular monolith, boring tech, automation, documented ADRs | Exec |
| R11 | Incumbent competition (CleanCloud, Starchup, SMRT, Laundryheap-type tools, etc. — *to be verified by market research*) | 4 | 3 | 12 | Differentiate: configurable workflow engine, true multi-branch finance, commercial B2B, Canadian-first | Strategy |
| R12 | Dual-role conflict (Eazy competes with its own subscribers) | 3 | 4 | 12 | Transparent policy: strict isolation, no data use, contractual non-use clause, no cross-tenant benchmarking without opt-in/aggregation threshold | Exec |
| R13 | Data migration from incumbents blocks onboarding | 4 | 3 | 12 | CSV importers (customers/services/orders), migration service | Eng/CS |
| R14 | AI misstatement of financials | 2 | 4 | 8 | Tool-calling over metric registry only, cited calculations, labels | AI |
| R15 | Security incident via support access | 2 | 5 | 10 | Consent-based scoped grants, audit, alerts | Security |
| R16 | Cloud cost growth (maps, SMS, storage) | 3 | 3 | 9 | Quotas/allowances, caching, cost dashboards | DevOps |
| R17 | Performance degradation at scale | 2 | 4 | 8 | Index discipline, load tests, partitioning plan, read replicas | Eng |
| R18 | Legal exposure from garment damage/loss claims workflow | 3 | 3 | 9 | Configurable liability policies; tenant's T&Cs; evidence capture | Legal |
| R19 | Healthcare/regulated linen misuse | 2 | 4 | 8 | Excluded at launch; ToS; compliance review before enabling | Legal |
| R20 | Brief internal contradictions create rework | 3 | 3 | 9 | Conflict log (00), ADRs, early sign-off | Architect |

## B. Commercialization strategy

**Positioning:** "The operating system for modern laundries" — one platform for counter, plant, route and books, built for Canadian operators (CAD, GST/PST, PIPEDA, Alberta-first).

**Segments & sequencing (wedge → expansion)**
1. *Wedge:* pickup/delivery & wash-and-fold shops (clear pain: scheduling, routes, tracking) — plus Eazy Group's own operation as reference customer.
2. *Expand:* dry cleaners (garment-level), multi-branch operators.
3. *Then:* commercial/B2B laundries (high ACV, contract/invoicing depth), self-service (needs hardware partnerships).
4. *Later:* Enterprise/custom, other provinces/US.

**Go-to-market (hypotheses to test):** design-partner program (3–5 free/discounted pilots with case studies) → founder-led sales & local laundry associations/trade shows → SEO/content for "laundry software Canada" → migration offers from spreadsheets/legacy tools → referral program → partner with equipment distributors/POS resellers. Public storefront gives each tenant a "Powered by EazyLaundry" backlink on lower plans (organic acquisition).

**Pricing (to validate):** plans in 09. Price-test via interviews & willingness-to-pay (Van Westendorp) before public launch; annual discount; modules as add-ons; optional payments application fee (Q1) aligned with value; avoid per-order metering. Unit-economics model: target gross margin ≥ 80 %, CAC payback ≤ 12 months, logo churn ≤ 2 %/mo for SMB — **targets, not forecasts**; build a model in a spreadsheet using real pilot data.

**Dual-role governance:** published "Eazy Group operating business" policy: same product, same terms, isolated tenant, no access to subscriber data, no use of subscriber data for competitive purposes.

**Launch criteria for public SaaS:** ≥ 3 design partners live ≥ 60 days; isolation suite & pen-test clean; backup/restore drill passed; billing lifecycle verified in live mode with test tenants; legal docs (ToS, DPA, privacy policy) reviewed by counsel; support runbook & status page.

**Support model:** in-app help, knowledge base, email/chat, tiered SLA by plan; onboarding checklist and import tools.

## C. Open market-research tasks (not yet done; no claims made above are validated)
Competitor feature/price matrix · TAM/SAM for Canadian laundries (Statistics Canada NAICS 812320/812310 + trade associations) · WTP interviews · regulatory scan per province (tax, consumer protection, privacy, CASL) · hardware compatibility survey.
