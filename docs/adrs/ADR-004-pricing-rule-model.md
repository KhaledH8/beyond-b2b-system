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
