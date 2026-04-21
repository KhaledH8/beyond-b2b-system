# Architecture Overview

Living document. When this and an ADR disagree, the ADR wins and this file
must be updated to match.

## 1. One-paragraph description

Beyond Borders is a multi-tenant travel distribution platform that ingests
hotel inventory from multiple supplier types (aggregators and direct
contracts) through a single adapter contract, maps all inventory to one
canonical hotel per real hotel, prices it with account-aware rules, and
distributes it across B2C, agency, subscriber, and corporate channels —
with merchandising as a separate, non-pricing display layer.

## 2. Architectural style

**Modular monolith** with **event-driven edges**:

- A single deployable backend (`apps/api`) composed of strongly bounded
  modules (pricing, mapping, content, merchandising, booking, tenancy).
- A worker process (`apps/worker`) running the same codebase, consuming
  queues for content refresh, mapping, saga execution, and reconciliation.
- Module boundaries are enforced in the repo (see ADR-011) so any module
  can later be extracted into a standalone service with minimal rewrite.
- Microservices rejected for MVP: they crush small teams and force
  premature API design. See ADR-007 for stack, ADR-011 for repo shape.

## 3. Subsystem map

```
 ┌────────────────────────┐        ┌───────────────────────┐
 │ Supplier Adapters      │        │ Direct Contract       │
 │ (Hotelbeds, WebBeds,   │        │ Intake                │
 │  TBO, Rayna?, Rapid?)  │        │ (negotiated rates,    │
 │                        │        │  allotments, seasons) │
 └─────────┬──────────────┘        └──────────┬────────────┘
           │  unified SupplierAdapter         │
           ▼  contract (ADR-003)              ▼
 ┌─────────────────────────────────────────────────────────┐
 │ Canonical Sourcing                                       │
 │  Static pipeline  ──►  Content merge  ──► CanonicalHotel │
 │  Dynamic pipeline ──►  SupplierRate (ephemeral)          │
 └───────────────────────┬─────────────────────────────────┘
                         │
                         ▼
 ┌─────────────────────────────────────────────────────────┐
 │ Hotel Mapping (ADR-008)                                  │
 │  Normalize → deterministic match → (fuzzy queue) → map   │
 │  Auditable, reversible, human-reviewable                 │
 └───────────────────────┬─────────────────────────────────┘
                         │
                         ▼
 ┌─────────────────────────────────────────────────────────┐
 │ Pricing Engine (ADR-004)                                 │
 │  Source selection (per-account) → net cost → markup chain│
 │  → line-item taxes/fees → floor/ceiling → promotions     │
 │  → PricedOffer with full trace                           │
 └───────────────────────┬─────────────────────────────────┘
                         │
                         ▼
 ┌─────────────────────────────────────────────────────────┐
 │ Ranking + Merchandising (ADR-009)                        │
 │  Price-first ranking, relevance, quality; capped boosts  │
 │  Campaigns, sponsored slots, badges — never mutate price │
 └───────────────────────┬─────────────────────────────────┘
                         │
                         ▼
 ┌─────────────────────────────────────────────────────────┐
 │ Channels                                                 │
 │  B2C OTA │ Agency portal │ Subscriber portal │ Corporate │
 │  Partner API (later, for platform resale)                │
 └─────────────────────────────────────────────────────────┘

Booking orchestration (ADR-010) runs alongside, driving the
state machine from cart to confirmed booking and ledger entry.
```

## 4. Key invariants

1. **Source-agnostic downstream.** Below the sourcing layer, no code
   branches on supplier identity. Applies equally to aggregators,
   direct paper contracts, direct CRS, and direct channel-manager
   adapters (ADR-013).
2. **Static vs dynamic separation** (ADR-005). No merging of pipelines,
   no caching of dynamic rates beyond supplier terms. Push-mode
   ingestion writes to a freshness-bounded store (ADR-013).
3. **One canonical hotel per real hotel** (ADR-002, ADR-008).
4. **Account-aware pricing** (ADR-004). Rules attach to accounts and
   account types, not only to channel types. Market-adjusted markup
   (ADR-015) reads benchmark snapshots but never becomes supply.
5. **Merchandising never mutates price** (ADR-009).
6. **Tender is not pricing** (ADR-012, ADR-014). Wallet, loyalty,
   referral, credit, and card are tenders paying the sellable amount;
   none of them are pricing rules.
7. **Wallet is our ledger** (ADR-012). Stripe is a rail; the internal
   double-entry ledger is truth. Cash, promo, loyalty, referral, and
   credit are separate books.
8. **Rewards mature, not instant** (ADR-014). Accruals post PENDING
   and mature POSTED after a clawback window. Referral requires
   anti-fraud clearance.
9. **Supply connectivity ≠ market intelligence** (ADR-013 vs ADR-015).
   ARI feeds are supply; benchmark snapshots are advisory pricing
   input. Different modules, different tables.
10. **Tenancy is day-one** (ADR-006).
11. **Every booking is a durable saga with compensations** (ADR-010)
    including tender resolution and rewards accrual steps.
12. **Every supplier call is idempotent and auditable** (ADR-003).

## 5. Deployable units

- `apps/api` — HTTP API backend.
- `apps/worker` — queue consumers (content refresh, mapping, saga
  execution, reconciliation, reward maturation, benchmark ingestion,
  channel-manager ARI ingestion dispatch).
- `apps/b2c-web`, `apps/b2b-portal`, `apps/admin` — Next.js frontends.
- Shared Postgres, Redis, object storage, and search (Postgres+PostGIS
  first, OpenSearch later).
- External rails: Stripe (payment, refunds, Connect transfers).

## 5a. Module map (runs inside `apps/api` and `apps/worker`)

```
┌─────────────────────────────────────────────────────────────────┐
│ Booking orchestration (ADR-010) — saga, state machine           │
│   ├─ Tender resolution → ledger + payments + credit             │
│   └─ Rewards accrual (soft-terminal)                            │
└─────────────────────────────────────────────────────────────────┘
                  │                     │                  │
                  ▼                     ▼                  ▼
┌──────────────────────┐  ┌──────────────────────┐  ┌──────────────────────┐
│ Ledger (ADR-012)     │  │ Payments (ADR-012)   │  │ Rewards (ADR-014)    │
│ double-entry,        │  │ Stripe Connect,      │  │ loyalty earn,        │
│ wallet accounts,     │  │ PaymentIntent,       │  │ referral engine,     │
│ credit lines         │  │ webhooks, transfers  │  │ anti-fraud,          │
│                      │  │                      │  │ maturation worker    │
└──────────────────────┘  └──────────────────────┘  └──────────────────────┘

┌──────────────────────┐  ┌──────────────────────────────────────────────┐
│ Pricing (ADR-004)    │  │ Rate intelligence (ADR-015)                  │
│ rule engine, trace   │◄─│ benchmark sources, snapshots, query API      │
│ MARKET_ADJUSTED_…    │  │ advisory only, no sellable rates             │
└──────────────────────┘  └──────────────────────────────────────────────┘
```

## 6. Flows

Detailed in `docs/flows/`:
- **Search** — channel + account context in, ranked priced options out.
- **Booking** — cart → quote → auth → supplier book → capture → confirm.
- **Cancellation** — policy lookup → supplier cancel → refund → ledger.
- **Reconciliation** — supplier statements vs internal bookings.
- **Content refresh** — scheduled static pulls per supplier with diff
  into canonical profiles.

## 7. What changes this document

Any new ADR that touches sourcing, mapping, pricing, merchandising,
booking, or tenancy updates the corresponding section here. No silent
drift.
