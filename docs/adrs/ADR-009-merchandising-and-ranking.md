# ADR-009: Merchandising and ranking

- **Status:** Accepted
- **Date:** 2026-04-21

## Context

Two business needs pull in opposite directions:

- **Commercial:** promote certain hotels (direct contracts, higher-margin
  sources, partner deals, BB-picks, paid sponsorships).
- **Trust:** buyers — especially corporate and agency buyers — must see
  honest, explainable pricing.

These are reconciled by separating **ranking** from **pricing** and by
separating **merchandising** from both.

## Decision

### Three layers, in this order

1. **Pricing engine** (ADR-004) produces `PricedOffer`s with a price
   trace. Merchandising does not exist here.
2. **Ranking** orders `PricedOffer`s for a user query. Ranking may use
   price, relevance, and a **merchandising boost vector** — but it
   never mutates the price itself.
3. **Merchandising surface** adds labels, badges, pins, and sponsored
   slots on top of the ranked list.

### Default ranking signal

**Primary:** best comparable sellable price for this account context
(i.e., the price the viewer would actually pay, after their pricing
rules). This is the single most important default; violating it by
default erodes trust.

**Secondary (relevance):**
- Query fit (destination match, date match, room match).
- Amenity match to filters.
- Star rating match.
- Distance from query point of interest.

**Tertiary (quality signals):**
- Content completeness (good description, ≥N images, moderated).
- Historical booking success rate.
- Cancellation policy leniency (small positive boost for refundable
  at equal price).

**Boost vector (merchandising influence, bounded):**
- Capped influence — a boost can change rank, but only within a
  capped window per position, configurable per tenant and channel.
- Every boost is tagged with its campaign id and reason in the
  returned result (for audit and admin display).

### Campaign model

```
MerchandisingCampaign {
  campaign_id
  tenant_id
  name, status
  targeting: {
    account_types[]?, account_ids[]?, markets[]?, date_range,
    query_keywords[]?
  }
  placements: [
    { type: PIN_TOP | SPONSORED_SLOT | BADGE | BOOST,
      params: { position?, boost_weight?, badge_label?, ... } }
  ]
  budget?, pacing?
  disclosure_required: bool   // true for SPONSORED_SLOT per regulation
  canonical_hotel_ids[]
  priority int
  created_by, created_at
}
```

### Placement semantics

- **PIN_TOP** — force rank ≤ N (configurable cap). Visible as a small
  label (e.g., "Featured"). Not a sponsorship disclosure.
- **SPONSORED_SLOT** — paid placement. **Always labeled** as sponsored.
  Max count per page is capped and separate from organic results.
- **BADGE** — label only (e.g., "BB Pick", "Direct Rate", "Member
  Exclusive"). No rank change.
- **BOOST** — additive rank signal with a cap. Cannot place a hotel
  above the top-N organic results if its price is materially worse
  than the organic top (configurable).

### What merchandising cannot do

- Cannot mutate a `PricedOffer`'s amount, breakdown, or currency.
- Cannot hide a cheaper offer for a user who is entitled to see it.
- Cannot apply a "premium" that increases price for sponsored hotels.
- Cannot target a specific individual user for differential pricing
  (this is a pricing rule if anything, not merchandising).

### B2B safeguards

For agency and corporate channels:
- Sponsored slots are off by default; a tenant can enable them per
  account type.
- Corporate accounts with negotiated rates always see negotiated
  rates first, regardless of merchandising.

### Presentation metadata on results

Every returned offer carries a small `display` block:
```
display: {
  badges: [{ label, campaign_id?, tooltip? }],
  pinned: bool,
  sponsored: bool,
  rank_reason: "ORGANIC" | "PINNED" | "SPONSORED" | "BOOSTED",
  boost_applied: number
}
```

This is what the frontend renders. It is also what admins audit.

## Consequences

- Ranking becomes a real subsystem with its own module; it is not a
  `ORDER BY price ASC` one-liner.
- Campaign authoring and reporting become Phase 3+ admin features.
- We can honestly tell corporate clients "sponsored placements cannot
  change your price or hide your negotiated rate" — because the model
  forbids it.

## Open items

- Boost cap defaults per channel — tune in Phase 3 with live data.
- Sponsorship disclosure wording and visual style per jurisdiction —
  coordinate with legal before Phase 3 launch.
