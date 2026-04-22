# ADR-014: Loyalty, rewards, and referral program

- **Status:** Accepted
- **Date:** 2026-04-21
- **Amends:** ADR-010 (booking orchestration — reward accrual step),
  ADR-012 (payments/wallet — reward balance types and lifecycle).
  **Promotes** loyalty/referral from MVP non-goal to first-class
  architecture concern; ADR-001 §6 is superseded for this specific
  non-goal.

## Context

Loyalty and referral are no longer deferred. They are product
commitments:

- **Loyalty** — every booking earns rewards for the buyer (B2C and,
  where policy allows, B2B bookers acting on their own account).
- **Referral** — B2C users get a referral code; when someone they
  refer completes a qualifying booking, **both parties** receive a
  reward.

Both programs must:

1. Avoid paying out on cancelled bookings (clawback).
2. Avoid paying out on fraud (anti-fraud gate, especially referral).
3. Be explainable per user ("why did I earn / not earn this?").
4. Fit the internal ledger model (ADR-012), not be a bolt-on balance.

## Decision

### Rewards are ledger entries, not special numbers

All reward balances live on the ledger (ADR-012) as `LOYALTY_REWARD`
and `REFERRAL_REWARD` books. All accruals, maturations, and clawbacks
are `LedgerEntry` rows with `kind` in the reward family.

### Loyalty — earn, mature, redeem

#### Earn rules

A `LoyaltyEarnRule` is scoped (tenant, account_type, supplier,
source_type, market, rate_class) — mirroring `PricingRule` scope
semantics from ADR-004. At booking confirmation:

1. Resolve the most specific matching earn rule for the booking.
2. Compute `earned_amount = f(booking_net_value, earn_rate, caps)`.
3. Post `LedgerEntry{kind: REWARD_ACCRUAL, status: PENDING}` on the
   buyer's `LOYALTY_REWARD` wallet.

Formula shapes supported: `PERCENT_OF_NET`, `PERCENT_OF_MARKUP`,
`FIXED_PER_NIGHT`, `TIERED`.

#### Maturation

A pending accrual matures to `POSTED` (redeemable) after the **later**
of:

- The stay's `check_out_date + clawback_window_days` (default 7).
- The booking's non-refundable boundary (if booking was still
  refundable, rewards stay pending).
- Supplier-confirmed non-cancellation (where the supplier reports
  stayed/no-show status).

Maturation is a scheduled job (`maturation-worker`) that runs daily
and posts `REWARD_MATURATION` entry pairs.

#### Clawback

On cancellation or refund post-accrual:

- Pending accrual → `REWARD_CLAWBACK` voids the pending entry.
- Matured accrual already redeemed → clawback is attempted against
  the remaining matured balance; if insufficient, a negative balance
  is recorded and settlement policy (tenant-configurable) applies
  (`DEBT_TOLERATED | AUTO_DEDUCT_ON_NEXT_EARN | SUSPEND_REWARDS`).

#### Redemption

Loyalty rewards redeem as a **tender** at checkout (ADR-012 tender
composition). They do **not** change a `PricedOffer`. They are a
payment instrument, just like cash or card. This preserves the
merchandising invariant (ADR-009) and the pricing trace invariant
(ADR-004).

Per-tenant redemption policies (`TenderPolicy`):
- Max % of booking redeemable with loyalty.
- Whether loyalty stacks with `PROMO_CREDIT` or `REFERRAL_REWARD` on
  the same booking.
- Minimum redemption threshold.

### Referral — invite, qualify, mature

#### State machine

```
ReferralInvite {
  invite_id, tenant_id,
  referrer_account_id,
  referral_code,
  invited_email?,       // if sent via email
  invited_account_id?,  // populated on signup
  state:
    ISSUED             // code exists, no signup yet
    SIGNED_UP          // invitee created account
    BOOKED             // invitee completed a qualifying booking
    PENDING_REVIEW     // anti-fraud review required
    PENDING_MATURATION // both sides' accruals posted PENDING
    MATURED            // both sides redeemable
    CLAWED_BACK        // qualifying booking cancelled/refunded
    FRAUD_BLOCKED      // anti-fraud rejected
    EXPIRED            // time-limited invite lapsed
  signup_at, first_booking_at, matured_at, notes
}
```

#### Qualification criteria (tenant-configurable defaults)

- Invitee's first **completed** booking on the platform.
- Booking net value ≥ threshold (default small minimum).
- No self-referral (see anti-fraud).
- Invitee and referrer are distinct humans (see anti-fraud).
- Booking passes the same clawback window as loyalty maturation.

#### Anti-fraud gate (mandatory before any referral accrual POSTED)

Signals evaluated:

- Payment method match (same card as referrer) → hard block.
- Device fingerprint match (same browser / device id) → hard block.
- IP proximity (same /24 repeatedly) → soft flag.
- Email similarity (same domain + tight lexical distance) → soft flag.
- Velocity caps (referrer acquiring > N referrals per window) →
  soft flag; threshold triggers hold.
- Hold list (known abusive accounts / payment BINs) → hard block.

Hard blocks send the invite to `FRAUD_BLOCKED`. Soft flags accumulate
into a score; a configurable threshold routes to `PENDING_REVIEW` for
manual action. Clean invites proceed directly to `PENDING_MATURATION`.

The anti-fraud engine is a separate module (`packages/fraud` or a
submodule within `packages/rewards`) with typed signal inputs and a
decision trace per invite. Trace is persisted for every invite —
auditability is non-negotiable.

#### Reward posting

On successful qualification + anti-fraud clearance:

- Referrer: `LedgerEntry{kind: REWARD_ACCRUAL, status: PENDING}` on
  their `REFERRAL_REWARD` wallet.
- Referee: same, on their `REFERRAL_REWARD` wallet.

On maturation (same clawback-window logic as loyalty): status → POSTED.

### Booking saga integration

ADR-010 booking saga gains a new terminal step:

```
... PAYMENT_CAPTURED → CONFIRMED → NOTIFIED → REWARDS_ACCRUED
```

- `REWARDS_ACCRUED` is a soft-terminal state. Failure to accrue does
  **not** unwind the booking; it enqueues a retry and raises an ops
  alert. The booking is already valid.
- Maturation happens later via the `maturation-worker`, not inside
  the booking saga.

### Why rewards never mutate price

Mirroring ADR-009's merchandising invariant: rewards are a **tender**,
not a **rule**. The pricing trace shows the amount charged; the
payment trace shows how the charge was tendered (cash + loyalty +
card, etc.). Two independent audit trails. A user cannot see one
number without the other, but they are not entangled.

## Consequences

- Rewards economics are auditable to the cent via the ledger.
- Cancellation handling is uniform — cancel a booking, run the same
  clawback step.
- Adding new earn/invite rules is configuration, not deploy.
- Anti-fraud is non-optional for referral. This is operational cost
  we accept to avoid program abuse.

## Anti-patterns explicitly forbidden

- Awarding rewards before booking status stabilizes (i.e., on
  `PAYMENT_AUTHORIZED` instead of post-maturation).
- Paying out on a refunded booking.
- Treating loyalty/referral as a pricing discount inside ADR-004 —
  they are tenders.
- Shipping referral without anti-fraud. The cost of launching without
  it is paid out in fraud dollars within weeks.
- Running maturation in the booking saga hot path.

## Open items

- Tiered loyalty (Silver/Gold/etc.) — Phase 4. Tier state is a
  derived view of accrual history; no new primitives needed.
- Cashback-as-cash (convert `LOYALTY_REWARD` → `CASH_WALLET`) — off
  by default; jurisdictional implications per ADR-012.
- B2B loyalty for agencies (commission rebates) — distinct from B2C
  loyalty; may reuse machinery in Phase 4.
- Referral-of-referral chains (multi-level) — explicitly out. One
  level only to avoid MLM patterns and regulatory exposure.

---

## Amendment 2026-04-22 — Margin-based reward economics, funding source, overrides

### Why this amendment

The original decision defaulted `LoyaltyEarnRule` to `PERCENT_OF_NET`
and did not distinguish where reward cost is funded from. In practice,
paying rewards as a percentage of booking gross value breaks the
economics on thin-margin bookings: a 2% gross reward on an 8% gross-
margin booking consumes a quarter of the margin. Worse, it rewards
low-margin sources and punishes margin-protecting ones, which is the
opposite of what we want commercially.

Additionally, hotels and sources occasionally want to **co-fund** a
reward boost (campaign, launch promotion, compensation for a service
incident). There was no primitive for that, and no way to reconcile
"who paid for this reward" in the ledger.

This amendment corrects both gaps. It is a **design correction**, not
a new decision in conflict with the original; the earning **machinery**
(pending accrual, maturation, clawback, tender redemption, anti-fraud
on referral) stays exactly the same. Only the **earn computation**, the
**rule type surface**, and **who the cost lands on** change.

### The margin-based default

The default `LoyaltyEarnRule` (and default B2B kickback rule, see
below) earns from **`recognized_margin`**, not from booking gross value
or booking net value.

#### `recognized_margin` — canonical definition

For a confirmed booking `B`:

```
recognized_margin(B) =
    sellable_amount(B)            // what the buyer is charged, excl. taxes/fees
  - net_cost(B)                   // what the supplier charges us, in pricing currency
  - payment_processing_cost(B)    // card fees, FX spread, etc. (estimated bracket at accrual, reconciled at capture)
  - known_refundable_discounts(B) // any pricing-rule discount that is contractually ours to eat
```

**Included** (added to the margin side, increasing rewardable margin):

- Markup we charge above net cost.
- Commission / rebate we receive from the supplier post-booking, if
  known at maturation time.

**Excluded** (never part of `recognized_margin`):

- Taxes and fees collected on behalf of a government or supplier —
  these are pass-through, not ours.
- Promo credit redeemed on the booking — the promo credit was *our*
  prior liability; including it would double-count.
- Other rewards redeemed on the booking (loyalty/referral tender).
  Rewards redeeming against a booking reduce `recognized_margin`
  by their face value; earning on top of that would compound.
- Merchandising campaign boosts (ADR-009) — merchandising does not
  mutate price, and it does not mutate margin either.
- Agency commission payable out to the booking agency — that is
  their margin, not ours.

`rewardable_margin` is a tenant-configurable **view** over
`recognized_margin`:

- Floor (e.g. ignore margins < USD 5; no reward).
- Ceiling (e.g. cap rewardable margin at USD 500 per booking).
- Fraction (e.g. only 60% of realized margin is rewardable; the rest
  is protected as operating margin).

The floor/ceiling/fraction are per-tenant defaults, overridable per
rule scope.

#### Why margin-based, not gross-based

| Concern | Gross-based | Margin-based |
|---|---|---|
| Thin-margin booking | Reward can exceed margin → loss per booking | Reward bounded by margin by construction |
| Rate-protected hotels | Penalized (same reward for less revenue) | Naturally rewarded (more margin → more reward funding headroom) |
| Commission-shifting sources | Indistinguishable | Sources that improve our take land better rewards |
| Rate-shopping suppliers | Incentive to push low-net-cost low-margin inventory | Incentive to push inventory we actually make money on |
| Audit | "Why did this booking earn more?" = rate card lookup | "Why did this booking earn more?" = ledger-traceable margin |

### New rule types

`LoyaltyEarnRule.formula` is extended. The full supported set is now:

- **`PERCENT_OF_MARGIN`** *(new default)* — `earn = pct × rewardable_margin`.
- **`FIXED_REWARD_BY_MARGIN_BRACKET`** *(new)* — step function over
  `recognized_margin` brackets. E.g. margin 0-20 → 1 point, 20-50 → 3
  points, 50-100 → 8 points, 100+ → 20 points. Lets a tenant publish
  a tier-feel reward without committing to a percentage on every
  booking.
- **`HOTEL_FUNDED_BONUS`** *(new)* — on top of a base rule. A signed
  hotel-funded campaign posts an additional accrual with
  `funding_source = HOTEL_FUNDED`. Must reference a
  `RewardCampaign` row with valid start/end and the funding
  agreement audit id.
- **`MANUAL_OVERRIDE`** *(new)* — an ops user authors a specific
  `RewardPosting` (grant or reduction) with mandatory reason code,
  actor, and approval trail. Used for service recovery, launch
  incentives, goodwill adjustments. Never fires automatically.
- **`CAP_AND_FLOOR`** *(new, composable)* — wrapper applied after
  another formula, enforcing min/max on the computed amount. Not a
  standalone formula; attaches to any rule.
- `PERCENT_OF_NET` — **retained but deprecated for default use.**
  Allowed only for specific tenant-configured legacy rules, and must
  be flagged in the rule UI as a gross-based formula.
- `PERCENT_OF_MARKUP` — retained. Close cousin of
  `PERCENT_OF_MARGIN` but doesn't subtract payment processing or
  refundable discounts; kept for simple back-of-envelope contracts.
- `FIXED_PER_NIGHT` — retained for niche use.
- `TIERED` — retained for derived-tier multipliers (Silver ×1.0,
  Gold ×1.25, etc.) composed on top of the base formula.

### Funding source — a first-class field

Every `RewardPosting` (and its backing `LedgerEntry`) carries a
`funding_source`:

- **`PLATFORM_FUNDED`** — Beyond Borders (or the tenant itself)
  funds the reward out of its own margin. Default for loyalty earned
  via `PERCENT_OF_MARGIN`, referral rewards, and standard promos.
- **`HOTEL_FUNDED`** — a specific hotel / supplier has committed
  (via `RewardCampaign` + signed funding agreement) to fund the
  reward. The ledger records a **payable to platform / receivable
  from hotel** leg so the cost ultimately lands on the hotel at
  invoice/reconciliation time.
- **`SHARED_FUNDED`** — split between platform and hotel per a
  configured ratio. Two ledger legs, one per funder.

Funding source is **load-bearing for accounting**, not a cosmetic
label:

- Reporting and P&L can split reward cost by funder.
- Clawback unwinds the funder-specific leg, not just the buyer-side
  accrual.
- An audit can answer "who paid for this reward?" with a SQL query
  over the ledger, not a reconstruction from rules.

`HOTEL_FUNDED` and `SHARED_FUNDED` postings **must** carry:

- `campaign_id` → `RewardCampaign` row.
- `funding_agreement_ref` → admin-visible link to the signed
  agreement (document store URL or similar).
- `approved_by` → internal user id for the commercial signoff.

Without all three, the ledger write is rejected. This is an
architectural invariant.

### New entities

- **`RewardCampaign`** — time-bounded reward boost with `scope`
  (hotel, supplier, rate-plan, market, account-segment),
  `funding_source`, `funding_agreement_ref`, `bonus_formula`,
  `budget_cap` (optional hard stop), `approved_by`, `start_at`,
  `end_at`, `status` (DRAFT | ACTIVE | EXHAUSTED | EXPIRED |
  CANCELLED).
- **`HotelRewardOverride`** — per-hotel (or per-supplier) persistent
  override, distinct from a campaign. Lets a hotel permanently lift
  or lower the base earn rate for bookings at its property. Carries
  the same funding-source metadata as a campaign.
- **`RewardFundingLeg`** — per-funder ledger leg accompanying a
  reward posting; allows a single reward to the buyer to be split
  across multiple funders cleanly. For `PLATFORM_FUNDED` there is
  one leg; for `SHARED_FUNDED` there are two.
- **`RewardOverrideAudit`** — append-only log of every manual
  override, with actor, reason code, previous state, new state, and
  link to the resulting `RewardPosting`.

### B2B kickback — same model, account-aware

B2B kickback (agency commission uplift, corporate rebate, subscriber
group bonus) is treated as **a loyalty earn rule scoped to that
account / account-type**, same machinery. Same `recognized_margin`
rule by default; same tender/ledger path on redemption (or payout to
an invoice credit).

Account-aware exceptions (per ADR-006 scope semantics):

- A specific agency may have a contracted override that pays out on
  net cost or on a flat per-booking basis. That override is a
  `LoyaltyEarnRule` scoped to that account with `formula =
  PERCENT_OF_NET` (or `FIXED_PER_NIGHT`), funding-source
  `PLATFORM_FUNDED`, documented via `AuditLog`.
- A corporate account may have zero rebate (rebated at invoice
  level instead).

Rule resolution remains specificity-ordered (ADR-004-style); the
most specific matching rule wins. There is never an auto-escalating
combination of rules.

### Rule resolution order at booking

At `REWARDS_ACCRUED` time the rewards service computes, in order:

1. Resolve the matching base rule (tenant, account, supplier,
   source_type, market, rate-class). Default is margin-based.
2. Apply any `HotelRewardOverride` that matches the booked hotel.
3. Evaluate active `RewardCampaign`s that match the booking (hotel,
   supplier, rate-plan, segment). Multiple campaigns may stack only
   if explicitly flagged `stackable_with` the others.
4. Apply `CAP_AND_FLOOR` wrappers.
5. Post one `RewardPosting` per active funding source, each with its
   own `RewardFundingLeg`.
6. `MANUAL_OVERRIDE` is never resolved here; it lives in the admin
   reward-management UI and posts directly.

### Observability

First-class metrics (dashboard per tenant):

- Reward cost by hotel (top spenders, outliers).
- Reward cost by `source_channel` / supplier (aggregator vs direct;
  which margin profile lands best).
- Reward cost by `funding_source` (platform vs hotel vs shared) —
  with hotel-funded accounts reconciled against invoicing.
- Reward cost vs `recognized_margin` band (are we paying 5% of
  margin on average? 30%? 80%?). A rising ratio is an early warning.
- Manual override volume and actor distribution — spike = abuse or
  policy gap.
- Campaign spend vs `budget_cap` with projected exhaust date.

### Anti-patterns, extended

Adding to the original list:

- Posting reward amounts computed on **gross booking value** by
  default. It ignores cost-of-sale and erodes margin silently.
- Mixing platform-funded and hotel-funded legs in a single
  `RewardPosting` without per-leg attribution. The ledger must
  always answer "who paid for this?" cleanly.
- Letting `MANUAL_OVERRIDE` be authored without a reason code or
  approver — the override surface is the primary abuse vector in
  reward programs.
- Treating `HotelRewardOverride` as "just another earn rule" in the
  pricing chain. It is a rewards-layer concern, never a pricing
  rule. Same invariant as the original: rewards are tender, not
  discount.
- Computing `recognized_margin` from live Stripe fees. Use bracket
  estimates at accrual; reconcile at capture. The ledger is truth;
  Stripe is a rail (ADR-012).

### Migration note

No legacy data exists yet (pre-Phase-2). The amendment is in force
for the very first loyalty implementation. The deprecation of
`PERCENT_OF_NET` as a **default** is immediate; tenants may still
choose it explicitly for specific rules, but the starter-kit default
for new tenants is `PERCENT_OF_MARGIN`.

### Cross-cutting references

- `recognized_margin` computation contract must be owned by the
  **pricing** module (it has the trace) and consumed by rewards via
  a narrow typed interface. Rewards never reads pricing internals.
- `funding_source = HOTEL_FUNDED` requires a reconciliation hand-off
  at supplier/hotel invoicing time. Parked as an open item until
  Phase 3 direct-contract invoicing scope is firm.
- Tiered rewards, lifetime points, post-completion crediting — see
  `docs/design/rewards-referral.md` §10 for the design lineage and
  how our implementation differs from spend-based programs.
