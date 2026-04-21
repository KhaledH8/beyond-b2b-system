# ADR-001: Foundational architecture decisions

- **Status:** Accepted
- **Date:** 2026-04-21
- **Deciders:** Beyond Borders (product owner) + Claude (assistant)
- **Supersedes:** —
- **Superseded by:** —

## Context

We are starting a travel distribution platform from zero. The platform will
be used by Beyond Borders but is designed so it can later be sold to other
travel agencies. We must lock in foundational decisions now so subsequent
design work does not drift.

Key pressures we are designing against:
- Multiple supplier types (aggregators and direct contracts) must coexist
  cleanly.
- Multiple audiences (B2C, agency, subscriber, corporate) must each be
  first-class, not retrofitted.
- Hotels first, with flights / transfers / activities explicitly deferred.
- Resale to other agencies is a real scenario, not aspirational.

## Decisions

### D1. This is a distribution engine, not a storefront

Everything is designed multi-tenant and multi-channel from the start. No
branding, currency, or business rule is hardcoded where it could be
configuration.

### D2. One canonical hotel per real hotel

Hotels from all sources are mapped into a single canonical profile. No
duplicates. Mapping is auditable and reversible. Deterministic signals
(supplier codes, geo, name, address) run before any fuzzy or ML approach.

### D3. Direct contracts are a first-class source

Direct hotel contracts implement the same supplier adapter contract as any
wholesale feed. They are not a side module, not an override layer, not a
spreadsheet import pipeline. Their data shape may differ at intake; the
adapter normalizes it.

### D4. Static content and dynamic rates are separated

Static hotel content (name, address, geo, images, amenities, description,
chain, rating) is cached and versioned. Dynamic rate and availability data
is fetched live, with only short, supplier-permitted TTL caching. They are
never merged into a single pipeline or a single cache.

### D5. Pricing is account-aware, designed to grow market-aware

Pricing precedence (applied after net cost is established):
1. Per-account markup.
2. Per-account-type default markup.
3. Per-supplier override (where allowed by contract).
4. Later: per-market, per-destination, per-season, per-rate-class rules.
5. Taxes and fees as line items, not folded into markup.
6. Promotions applied last, traceable to the rule that fired.

"Cost + flat %" is a temporary default, never the architecture.

### D6. Merchandising is a separate display layer

Sponsored, featured, and recommended placements can reorder or annotate
search results. They **cannot** mutate priced rates, net cost, or the
pricing rule chain. Violating this is grounds for reverting the change.

### D7. Tenancy is a day-one concern

Data models, auth, config, and feature flags are designed so a second
tenant is a configuration event, not a rewrite. Beyond Borders is the
first tenant, not the only tenant.

### D8. MVP scope discipline

MVP proves the hotel spine only: sourcing → mapping → pricing → booking →
basic ledger, across two aggregators plus one direct contract. Flights,
transfers, activities, loyalty, dynamic packaging, corporate approval
flows, and full finance/accounting are explicitly out.

### D9. Tech stack choice is deferred

Language, framework, datastore, queue, and cache are chosen after the
entity and adapter contract ADRs are written, so the tech follows the
domain. No stack is committed in this ADR.

### D10. Changes are additive and reversible

New files and clear docs are preferred over silent restructuring. Renames
and deletions require explicit approval. Risky refactors require a
checkpoint plan (what rolls back, what tests cover the blast radius) before
they start.

## Consequences

- Downstream code never branches on `if supplier == "hotelbeds"`. If it
  needs to, that is a smell pointing at the adapter contract.
- Mapping becomes a load-bearing subsystem. Under-investing here forces all
  later systems to compensate.
- Pricing cannot be simplified to "global markup" even on day one without
  wedging account-awareness in later.
- Merchandising needs its own data model (campaigns, placements, rules)
  rather than piggybacking on pricing.
- Tenancy complicates schemas slightly on day one, but avoids a migration
  nightmare later.

## Open items (not decisions, flagged for later ADRs)

- Canonical hotel data model (ADR-002).
- Supplier adapter contract shape (ADR-003).
- Pricing rule storage and evaluation (ADR-004).
- Static/dynamic split concrete TTLs and stores (ADR-005).
- Tenancy and account model (ADR-006).
- Tech stack (ADR-007).
- Mapping strategy v1 (ADR-008).

## Known risks

- **Booking.com Demand API** — may be commercially unavailable. Do not
  design toward it until confirmed.
- **Rayna** — technical integration unconfirmed. Treat as conditional.
- **Direct contract intake heterogeneity** — PDFs, spreadsheets, emails.
  Intake tooling is non-trivial and must not be underestimated.
