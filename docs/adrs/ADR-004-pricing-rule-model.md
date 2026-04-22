# ADR-004: Pricing rule model and precedence

- **Status:** Accepted
- **Date:** 2026-04-21

## Context

Pricing must support four audiences (B2C, agency, subscriber, corporate)
with account-level customization, and must grow into market-aware
pricing. It must be fully explainable — every offer carries a trace of
which rules fired. Merchandising must be kept entirely separate (ADR-009).

## Decision

### Rule entity

```
PricingRule {
  rule_id
  tenant_id
  scope:               // null on a field = "applies to all"
    account_id?        // most specific
    account_type?      // B2C | AGENCY | SUBSCRIBER | CORPORATE
    supplier_id?
    source_type?       // AGGREGATOR | DIRECT
    market_code?       // country/region/city code (phase 2+)
    rate_class?        // REFUNDABLE | NON_REFUNDABLE | PACKAGE
    season_code?       // phase 2+
  valid_from, valid_to
  type:   MARKUP | DISCOUNT | FLOOR | CEILING | FEE | FX_BUFFER
  formula: { kind: PERCENT | FIXED | TIERED; value | tiers[] }
  currency?            // null = apply in offer currency
  priority int         // tie-break within same specificity
  compound: ADDITIVE | MULTIPLICATIVE
  active bool
  created_by, created_at, notes
}
```

### Precedence (evaluation order)

For a given `PricedOffer` context `{tenant, account, account_type,
supplier, source_type, market, rate_class, dates}`:

1. **Source selection** (see ADR-009 ranking). Pick candidate
   `SupplierRate`s that are eligible for this account (supplier is
   enabled for the account, rate class is allowed, etc.).
2. **Net cost resolution.** Each candidate's supplier net cost in source
   currency, converted to pricing currency via today's FX with the
   `FX_BUFFER` rule (if any) applied.
3. **Markup chain.** Filter matching `MARKUP`/`DISCOUNT` rules. Sort by
   **specificity score**, then `priority`. Apply in order. Specificity
   score is additive: `account_id` = 100, `account_type` = 50,
   `supplier_id` = 20, `source_type` = 15, `market_code` = 10,
   `rate_class` = 5, `season_code` = 5.
4. **Line-item fees.** `FEE` rules attach as separate line items — they
   never fold into the base price. Taxes from suppliers pass through as
   separate line items too.
5. **Floor/ceiling.** `FLOOR` and `CEILING` rules clamp the result.
   Clamping is also recorded in the trace.
6. **Promotions.** Promotion rules apply last, on top of the displayed
   price, traceable to a promotion id.

### Pricing trace

Every `PricedOffer` carries:

```
PricingTrace {
  offer_id
  source_rate_ref
  steps: [
    { rule_id?, step_type, delta, currency, before, after, note }
  ]
  final: { amount, currency, display_breakdown[] }
}
```

Traces are persisted for every booked offer (for dispute and audit).
Traces on non-booked search results are ephemeral.

### Source selection inside pricing

Because a direct contract might have higher net cost but lower markup
than an aggregator for the same hotel and night, **source selection
depends on applied pricing**. The engine must:

- Evaluate the full rule chain for each eligible candidate source,
- Pick the one with the best resulting **sellable** price for the
  account context,
- Break ties with a configurable preference order (default: direct
  contract > preferred wholesaler > others).

### Currency and FX

- Every rate carries its source currency.
- The engine converts to a pricing currency chosen by account setting
  (with a tenant default).
- FX rates refresh daily from a configured provider. An `FX_BUFFER`
  rule (default 1–2%) protects against same-day drift and supplier
  re-quote surprises.

## Consequences

- Pricing is data, not code. New rules do not require a deploy.
- Traces make disputes solvable. Every disagreement between "what the
  user saw" and "what we charged" has a chain of receipts.
- Rule count can grow large at scale — indexing on scope fields is
  mandatory.
- Evaluating multiple candidates per hotel per request is more work than
  "pick cheapest net and mark up." That is the cost of doing this
  correctly.

## Anti-patterns explicitly forbidden

- Storing a pre-marked-up rate on any supplier row.
- A "sponsored boost" that multiplies the price — sponsorship is
  ADR-009 territory, never a pricing rule.
- Burying FX in markup — FX must be its own step in the trace.
- Hardcoded markup percentages in code.

## Open items

- Where rule storage lives (likely a dedicated table in the main
  Postgres, with a JSONB `scope` column and explicit indexed columns
  for the most common scope fields). Finalize in Phase 2.
- Rule authoring UI (admin) — Phase 2.
- Rule simulation / what-if tool — Phase 3 nice-to-have.

## Amendment 2026-04-21 (see ADR-012, ADR-014, ADR-015)

### Tender is not a pricing concern

Wallet balances (cash, promo credit, loyalty rewards, referral rewards,
agency credit) and card payments are **tenders**, not pricing rules.
Pricing produces the sellable amount; tenders pay it. Neither mutates
the other. This preserves the pricing trace as a closed, auditable
chain of rule applications. Full tender-composition model: ADR-012.

**Forbidden additions** (do not add as pricing rule types):

- Loyalty redemption as a `DISCOUNT` rule.
- Promo credit as a `DISCOUNT` rule.
- Agency credit as a price adjustment.
- Referral reward as a price adjustment.

### New rule type: `MARKET_ADJUSTED_MARKUP`

Introduced by ADR-015. Adds a markup mechanism that reads from the
`rate-intelligence` module's benchmark snapshots to produce a
market-aware markup, with mandatory fallback behavior when the
benchmark is stale/thin and mandatory trace entries recording the
snapshot id and decision. See ADR-015 for full formula shapes and
governance.

Evaluation slot: runs inside the **markup chain** (step 3 above),
sorted by specificity as any other markup rule. It is not a new
pipeline stage; it is a new rule type.

## Amendment 2026-04-21 (see ADR-020) — net cost and margin are mode-aware

The precedence pipeline is extended with a new trace step and
mode-aware net-cost resolution. The five-step shape is unchanged;
the semantics of step 2 and the content of the trace are refined.

### New trace step: `COLLECTION_AND_SETTLEMENT_BIND`

Inserted immediately after step 2 (net cost resolution). Records
the rate's `CollectionMode`, `SupplierSettlementMode`,
`PaymentCostModel`, and `gross_currency_semantics` from the
`SupplierRate` (ADR-003 + ADR-020 amendment). This step does not
change the sellable amount; it **binds** the booking's money-
movement semantics into the trace so that every downstream decision
(tender composition, document issuance, recognized-margin
computation) sees the same values.

### Net cost resolution by `gross_currency_semantics`

- `NET_TO_BB` (default, current behavior) — supplier returns net;
  markup chain operates over it; produces BB sell amount as today.
- `GROSS_TO_GUEST` — supplier returns the guest-facing gross;
  effective `net_cost = gross − commission`; markup chain operates
  over `net_cost`. The `gross → net` reduction is its own trace
  step with the commission rule id.
- `COMMISSION_RATE` — no gross on the rate; `net_cost = property_rate
  − commission` where `property_rate` comes from the supplier's
  content or a contracted property rate; markup chain operates over
  `net_cost`.

### `recognized_margin` is mode-aware

`recognized_margin` is owned by pricing (per the ADR-014 amendment
2026-04-22) and consumed by rewards. ADR-020 makes the cost-
inclusion list vary by `CollectionMode` and `PaymentCostModel`:

- `BB_COLLECTS` modes include platform card-fee estimation.
- `RESELLER_COLLECTS` excludes platform card fee (reseller bears it).
- `PROPERTY_COLLECT + COMMISSION_ONLY` and
  `UPSTREAM_PLATFORM_COLLECT + COMMISSION_ONLY` compute margin from
  the **commission stream**, not a gross-to-net differential.
- `VCC_TO_PROPERTY` includes the VCC-load / issuance fee estimate
  alongside any guest-side acquiring fee.

This is not a schema change to `recognized_margin`; it is a
computation contract. The guarantee is unchanged: `recognized_margin`
is never greater than the money BB actually earned on the booking.

### Forbidden additions reiterated (ADR-020)

- Computing margin from a gross BB never received
  (`UPSTREAM_NETTED`, `COMMISSION_ONLY`).
- Pricing a rate whose `(CollectionMode,
  SupplierSettlementMode)` pair is forbidden by ADR-020 — source
  selection filters these out before the pipeline runs.
