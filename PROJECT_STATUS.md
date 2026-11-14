# EazyLaundry — Project Status

_Last updated: 2026-11-14_

## Current phase
**Phase 0 — Discovery & Architecture** (awaiting review; no application code written)

## Completed
- Repository inspected: empty (no prior work to preserve).
- Discovery pack written: `docs/discovery/00`–`13` covering PRD, personas/journeys, functional requirements, screen inventory, architecture (system, integration, deployment), ERD & schema, tenant security & permission matrix & threat model, production workflows, financial architecture, SaaS entitlements, UX spec, testing strategy, risks, commercialization, roadmap.

## In progress
- Awaiting owner decisions D1–D5 (see `docs/discovery/00-index-and-decisions.md`).

## Outstanding (next)
- Phase 1 platform foundation (backlog in `docs/discovery/13-roadmap-scope.md` §3).

## Known bugs
None (no code).

## Technical debt
None yet.

## Architectural decisions (summary)
Modular monolith + worker · PostgreSQL shared schema + RLS (FORCE) + composite FKs · Drizzle + SQL-first migrations · Money as integer minor units · Immutable double-entry operational ledger · Outbox events · SSE live updates · Customers tenant-scoped · Provider adapters (Stripe Connect first) · Separate SSR storefront (proposed) · Separate platform console · AWS ca-central-1.
Details: `docs/discovery/04-architecture.md` §4 and `13-roadmap-scope.md` §5.

## Dependencies / external lead items
Stripe Connect account · Email domain auth (SPF/DKIM/DMARC) · Google Maps billing · AWS accounts · Legal docs · Design-partner recruitment · Reference hardware (scanner, receipt & label printers).

## Next milestones
1. Review & sign-off of discovery pack (D1–D5).
2. Phase 1 kickoff: repo scaffold, CI, DB roles, RLS harness.
3. Isolation test suite green before any business feature.

## Unverified claims / research debt
Pricing, market size, competitor landscape, conversion and unit-economics targets are **hypotheses**, not validated (see `docs/discovery/12-risks-commercialization.md` §C).
