# Architecture Overview

Living document. Updated as ADRs land. When this and an ADR disagree, the
ADR wins and this file must be updated to match.

## 1. One-paragraph description

Beyond Borders is a multi-tenant travel distribution platform that ingests
hotel inventory from multiple supplier types (aggregators and direct
contracts) through a single adapter contract, maps all inventory to one
canonical hotel per real hotel, prices it with account-aware rules, and
distributes it across B2C, agency, subscriber, and corporate channels —
with merchandising as a separate, non-pricing display layer.

## 2. Core subsystems

```
 ┌────────────────────────┐        ┌───────────────────────┐
 │ Supplier Adapters      │        │ Direct Contract       │
 │ (Hotelbeds, WebBeds,   │        │ Intake                │
 │  TBO, Rayna?, Rapid…)  │        │ (negotiated rates,    │
 │                        │        │  allotments, seasons) │
 └─────────┬──────────────┘        └──────────┬────────────┘
           │                                  │
           ▼                                  ▼
 ┌─────────────────────────────────────────────────────────┐
 │ Canonical Sourcing Layer                                │
 │  - Unified adapter contract                             │
 │  - Static content pipeline (content API, cached)        │
 │  - Dynamic rate/availability pipeline (live, short TTL) │
 └───────────────────────┬─────────────────────────────────┘
                         │
                         ▼
 ┌─────────────────────────────────────────────────────────┐
 │ Hotel Mapping                                           │
 │  - One canonical hotel per real hotel                   │
 │  - Deterministic-first match (codes, geo, name, addr)   │
 │  - Conflict queue for human resolution                  │
 │  - Mapping is auditable and reversible                  │
 └───────────────────────┬─────────────────────────────────┘
                         │
                         ▼
 ┌─────────────────────────────────────────────────────────┐
 │ Pricing Engine                                          │
 │  - Net cost selection (best valid source)               │
 │  - Account-aware markup rules                           │
 │  - Taxes/fees as line items                             │
 │  - Promotions layer (traceable)                         │
 │  - Returns priced options with full breakdown           │
 └───────────────────────┬─────────────────────────────────┘
                         │
                         ▼
 ┌─────────────────────────────────────────────────────────┐
 │ Merchandising Layer (display only, NEVER mutates price) │
 │  - Sponsored / featured / recommended                   │
 │  - Sort, boost, pin                                     │
 └───────────────────────┬─────────────────────────────────┘
                         │
                         ▼
 ┌─────────────────────────────────────────────────────────┐
 │ Channels                                                │
 │  - B2C OTA site                                         │
 │  - B2B agency portal                                    │
 │  - B2B subscriber / member portal                       │
 │  - B2B corporate portal                                 │
 │  - Partner API (later, for platform resale)             │
 └─────────────────────────────────────────────────────────┘
```

## 3. Key invariants

1. **Source-agnostic downstream.** Everything below the Canonical Sourcing
   Layer is unaware of whether a rate came from Hotelbeds, WebBeds, TBO, or
   a direct contract.
2. **Static vs dynamic separation.** Static content is cached and versioned;
   dynamic rates and availability are fetched live or via short, supplier-
   permitted TTLs. They never merge into one pipeline.
3. **One canonical hotel per real hotel.** All supplier references hang off
   it. Mapping is the single source of identity.
4. **Account-aware pricing.** Rules attach to accounts and account types,
   not only to channel types. A corporate account can have unique markup
   and unique visibility.
5. **Merchandising ≠ pricing.** The merchandising layer can reorder, pin, or
   label. It cannot change the priced rate, net cost, or rule chain.
6. **Tenancy is assumed.** Even with one tenant on day one, no schema, auth
   decision, or config mechanism should preclude a second tenant.

## 4. Flows (to be detailed in `docs/flows/`)

- **Search** — channel + account context in, ranked priced options out.
- **Booking** — availability check → rate confirm → book at supplier →
  voucher → ledger entry.
- **Cancellation** — policy lookup → supplier cancel → refund path →
  ledger.
- **Reconciliation** — supplier statements vs internal bookings.
- **Content refresh** — scheduled static pulls per supplier, diffed into
  canonical profiles, conflicts queued.

## 5. Deliberately deferred

Tech stack (language, framework, DB, queue, cache) is deferred until the
entity and adapter contract ADRs are written. We do not want to pick a
stack and then twist the domain to fit it.

## 6. What changes this document

Any new ADR that touches sourcing, mapping, pricing, merchandising, or
channels updates the corresponding section here. No silent drift.
