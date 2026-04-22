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
13. **Reseller settlement mode is explicit and gated** (ADR-018).
    Every `ResellerProfile` carries one of three versioned modes:
    `RESELLER_COLLECTS` (default; reseller bills guest directly, as
    ADR-017), `CREDIT_ONLY` (BB collects guest payment, earnings are
    non-withdrawable platform credit), or `PAYOUT_ELIGIBLE` (BB
    collects guest payment, earnings are withdrawable cash). The
    default on any new profile is `RESELLER_COLLECTS`.
14. **Non-withdrawable platform credit and withdrawable cash
    earnings are distinct books** (ADR-018). `RESELLER_PLATFORM_CREDIT`
    (CREDIT_ONLY mode) and `RESELLER_CASH_EARNINGS` (PAYOUT_ELIGIBLE
    mode) are separate `WalletAccount` balance types with different
    legal weight. Mixing them is an anti-pattern; upgrading
    `CREDIT_ONLY` → `PAYOUT_ELIGIBLE` does not convert historical
    credit into cash.
15. **Reseller cash earnings move through a ledger-derived state
    machine** (ADR-018): pending → available → (reserved) →
    paid_out, with clawback. States are projections over
    `RESELLER_EARNINGS_*` ledger rows, not a separate persisted
    enum.
16. **Payouts require strictly more evidence than credit accrual**
    (ADR-018). `PAYOUT_ELIGIBLE` requires a verified
    `ResellerKycProfile` with a business `legal_entity_kind`
    (`INDIVIDUAL_NOT_BUSINESS` never qualifies in MVP), clear
    sanctions / PEP screening, a VERIFIED `PayoutAccount` whose
    account holder name matches the KYC legal entity name, signed
    payout terms, and ops approval. Every withdrawal re-validates
    the gate set.
17. **Withdrawals always run through a `PayoutBatch`** (ADR-018).
    Even a single-request payout has a one-item batch record —
    batches are the unit of reconciliation against the rail.
    Clawbacks after payout are modelled by `RefundLiabilityRule`,
    which may (per contract) allow a first-class
    `NEGATIVE_AVAILABLE` state rather than a silent adjustment.
18. **Money-movement is a three-axis triple, declared per rate**
    (ADR-020). Every `SupplierRate` and every `Booking` carries
    `CollectionMode` (who collects the guest: BB / reseller /
    property / upstream platform), `SupplierSettlementMode` (how
    the supplier is paid: prepaid balance / postpaid invoice /
    commission-only / VCC / direct property charge), and
    `PaymentCostModel` (who bears the acquiring cost). Downstream
    code branches on these axes, never on supplier identity.
19. **Forbidden mode combinations are filtered at source
    selection** (ADR-020). E.g. `BB_COLLECTS + COMMISSION_ONLY`,
    `PROPERTY_COLLECT + PREPAID_BALANCE`, and
    `UPSTREAM_PLATFORM_COLLECT + VCC_TO_PROPERTY` are rejected
    before pricing runs. A rate with an invalid triple never
    reaches checkout.
20. **`recognized_margin` is mode-aware** (ADR-020 + ADR-014
    amendment). `BB_COLLECTS` includes platform card fee;
    `RESELLER_COLLECTS` excludes it (reseller bears it);
    `COMMISSION_ONLY` modes compute margin from the commission
    stream, not from a gross-to-net differential we never
    touched. Earning rewards from gross we never received is an
    explicit anti-pattern.
21. **No `TAX_INVOICE` to the guest on `PROPERTY_COLLECT` or
    `UPSTREAM_PLATFORM_COLLECT` bookings** (ADR-020). We did not
    sell the supply; we earned a commission. A new
    `COMMISSION_INVOICE` document archetype (BB → supplier /
    upstream) carries the commission record, numbered monotonic
    per (tenant, supplier_id, fiscal_year), separate from legal-
    tax-doc gapless sequences.
22. **No `PaymentIntent` mirror for money BB never touched**
    (ADR-020). `PROPERTY_COLLECT` and `UPSTREAM_PLATFORM_COLLECT`
    bookings skip authorize/capture entirely. A reseller-earnings
    accrual is rejected at ledger-write time on these bookings —
    we cannot accrue earnings from collections that did not flow
    through our rail.

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
│ Ledger (ADR-012,     │  │ Payments (ADR-012,   │  │ Rewards (ADR-014)    │
│   ADR-018)           │  │   ADR-018)           │  │ loyalty earn,        │
│ double-entry,        │  │ Stripe Connect,      │  │ referral engine,     │
│ wallet accounts,     │  │ PaymentIntent,       │  │ anti-fraud,          │
│ credit lines,        │  │ webhooks, transfers, │  │ maturation worker    │
│ reseller earnings    │  │ payout batches,      │  │                      │
│ (credit + cash)      │  │ withdrawal pipeline  │  │                      │
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
