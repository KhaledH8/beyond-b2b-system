# Rewards and referral — design note

- **Companion to:** ADR-014 (canonical decisions), ADR-012 (ledger),
  ADR-010 (booking saga reward step)
- **Audience:** engineers building the rewards module and the
  anti-fraud engine. Non-normative but elaborative.

## 1. Two programs, one ledger

Loyalty and referral are distinct programs with distinct state
machines but share the same underlying machinery:

- Both accrue as `REWARD_ACCRUAL` ledger entries (status PENDING).
- Both mature via the same maturation worker.
- Both clawback via `REWARD_CLAWBACK` entries.
- Both redeem as tender lines, never as pricing discounts.

The programs differ in:

- **Trigger shape** — loyalty on every booking; referral on
  qualifying first booking of a referred user.
- **State machine** — referral has an explicit `ReferralInvite`
  state machine with pre-accrual gates (anti-fraud).
- **Wallet destination** — `LOYALTY_REWARD` vs `REFERRAL_REWARD`.
- **Visibility** — loyalty is always visible to the buyer; referral
  state during anti-fraud review is internal until resolution.

## 2. The clawback window is the hinge

Everything around reward economics pivots on one parameter: the
clawback window.

- **Too short:** we pay rewards on bookings that get cancelled.
  Money lost.
- **Too long:** user perception of "the reward never comes" hurts
  loyalty.

Default: 7 days after stay checkout. Tenant-configurable per earn
rule. The maturation worker runs daily and promotes PENDING →
POSTED where:

```
now > max(
  booking.check_out_date + earn_rule.clawback_window_days,
  booking.non_refundable_boundary,
  supplier.confirmed_stay_or_no_show_event?.timestamp
)
```

Cancellation or refund during the window → `REWARD_CLAWBACK` voids
the pending accrual. No drama, no ops intervention, just a
compensating ledger entry.

## 3. Referral state machine — walkthrough

```
[Alice already has a B2C account]
  ↓ Alice clicks "invite"
ReferralInvite{state: ISSUED, referrer: alice, code: ABC123}

  ↓ Bob signs up with code ABC123
ReferralInvite{state: SIGNED_UP, invited_account: bob}

  ↓ Bob makes his first booking for 500 USD
ReferralInvite{state: BOOKED}
Run anti-fraud engine.

  ├─ Payment method match (same card as Alice) → hard block
  │    ReferralInvite{state: FRAUD_BLOCKED}
  │    No accruals. Decision stored in FraudDecision.
  │
  ├─ Soft flags over threshold
  │    ReferralInvite{state: PENDING_REVIEW}
  │    Queued for human reviewer in admin.
  │
  └─ Clean
       ReferralInvite{state: PENDING_MATURATION}
       Post REWARD_ACCRUAL{status: PENDING} to both wallets.

  ↓ Booking reaches maturation criteria
ReferralInvite{state: MATURED}
Accruals flip to POSTED (redeemable).

  ↓ Later cancellation
ReferralInvite{state: CLAWED_BACK}
REWARD_CLAWBACK voids both accruals.
```

Terminal states: `MATURED`, `FRAUD_BLOCKED`, `EXPIRED`,
`CLAWED_BACK`. Everything else is transitional.

## 4. Anti-fraud signals — concrete list

### Hard blocks (automatic FRAUD_BLOCKED)

- Referrer and referee share a payment method fingerprint (card
  BIN + last4 + expiry, or Stripe fingerprint).
- Referrer and referee share a device fingerprint.
- Referrer or referee appears on the internal `FraudHoldList`.

### Soft signals (score accumulates; threshold routes to
`PENDING_REVIEW`)

- IP in same /24 subnet.
- Same user-agent + same fingerprint family.
- Email address has tight lexical distance OR same domain +
  numeric suffix pattern.
- Referrer acquired > N referrals in the past Y days (velocity).
- Booking dates or property suspicious (immediately cancellable
  rate class + high reward value).
- Payment geography mismatch (card issued in country A, stay in
  country B, IP in country C — does not block alone but
  contributes).

Score and decision are persisted in `FraudDecision` per invite for
audit. Tenants can tune thresholds; no tenant can disable
anti-fraud outright for referral (architectural invariant).

## 5. Loyalty — what earns rewards

### 5.1 Starter-kit default (post-2026-04-22 correction)

Default loyalty earn rule (starter kit for new tenants):

- `PERCENT_OF_MARGIN`: **20% of `rewardable_margin`** (tenant-tunable;
  20% is a sane initial anchor — strong enough to feel generous to
  buyers, cheap enough that we are sharing our margin, not our
  revenue).
- Scope: `tenant=<tenant>, account_type=B2C`.
- `CAP_AND_FLOOR` wrapper: per-booking cap 50 USD-equivalent, floor 1
  USD (below floor → no accrual rather than a token amount).
- `funding_source: PLATFORM_FUNDED`.
- Clawback window: 7 days after checkout.

**Why margin, not net**: see ADR-014 amendment (2026-04-22). Gross-
based earning on a 500 USD booking that returns 40 USD of margin
to us would burn 25% of the margin on reward alone if the rate
were 2% of net. Margin-based earning keeps the reward program in a
predictable fraction of what the booking actually earns us.

### 5.2 `recognized_margin` in one paragraph

`recognized_margin = sellable_amount − net_cost −
payment_processing_cost − known_refundable_discounts`. Taxes and
fees pass through untouched. Rewards redeemed on the booking
**reduce** margin (they cost us on the other side of the ledger).
Agency commission paid out is not our margin. `rewardable_margin`
then clamps `recognized_margin` with an optional floor, ceiling,
and fraction (e.g. "only 60% of realized margin is rewardable"). The
pricing module owns the computation; rewards consumes it through a
narrow interface.

### 5.3 Rule types, briefly

| Formula | When it fits |
|---|---|
| `PERCENT_OF_MARGIN` | Default. Margin-aware, auditable, bounded. |
| `FIXED_REWARD_BY_MARGIN_BRACKET` | When the buyer-facing UX needs clean round numbers per booking bracket, not a floating percentage. |
| `HOTEL_FUNDED_BONUS` | A specific hotel co-funds extra earn for a campaign. Requires a signed `RewardCampaign`. |
| `MANUAL_OVERRIDE` | Ops grants a bespoke reward (service recovery, launch push, goodwill). Mandatory reason code + approver. |
| `CAP_AND_FLOOR` | Wrapper. Enforces per-booking min/max on any other formula's output. |
| `PERCENT_OF_NET` | Deprecated as a default. Allowed only for explicit legacy rules. |
| `PERCENT_OF_MARKUP` | Simpler cousin of margin-based. Useful for back-of-envelope commercial deals. |
| `FIXED_PER_NIGHT` | Niche — free-stay campaigns, subscription-like loyalty. |
| `TIERED` | Multiplier over a base formula (Silver ×1.0, Gold ×1.25, Platinum ×1.5). |

Specificity-score resolution (mirroring ADR-004 pricing rules) picks
the base rule; `HotelRewardOverride` and active `RewardCampaign`s
layer on top; `CAP_AND_FLOOR` clamps the result.

### 5.4 Funding source — three flavors

Every posting carries a `funding_source`:

- `PLATFORM_FUNDED` — default; we fund the reward from our own
  margin.
- `HOTEL_FUNDED` — the hotel pays for it. Requires a
  `RewardCampaign` with `funding_agreement_ref` and an approver.
  The ledger writes a receivable-from-hotel leg alongside the
  buyer-side accrual so invoicing/reconciliation can settle it.
- `SHARED_FUNDED` — split per a configured ratio. Two ledger legs,
  one per funder.

An auditor asking "who paid for this reward?" gets a clean SQL
answer from the ledger, not a reconstruction from rule logic. This
is the whole point of making funding source a first-class field.

### 5.5 B2B kickback — same machinery

Agency commission uplift, corporate rebate, subscriber group bonus
are all **loyalty earn rules scoped to the relevant account or
account-type**, using the same margin-based default. Account-
specific contracts can override (e.g. a flat per-booking kickback
for a long-standing agency). Payouts either accrue to the agency's
reward wallet (redeemed as tender on future bookings) or are
credited against the agency's invoice at cycle close — the choice
is configured per account, not hardcoded.

## 6. Redemption — tender, not discount

Rewards appear as a tender option at checkout:

```
Select how to pay:
  [ ] Card (remaining balance)
  [ ] Apply loyalty: 45 USD available (max 30% of booking)
  [ ] Apply promo credit: 20 USD available
```

The buyer's selection becomes `TenderComposition` lines. The
pricing trace shows the original 500 USD. The payment trace shows
"225 card + 45 loyalty + 20 promo + 210 card" (or whatever splits
the policy allows). **The price did not change.** The payment
composition changed.

`TenderPolicy` rules live per-tenant and drive what is offered:
- Max % of booking redeemable per reward type.
- Stackability (loyalty + promo on same booking — default yes;
  loyalty + referral on same booking — default no).
- Minimum redemption threshold.

## 7. Anti-patterns (repeat from ADR-014 for engineers)

- Posting rewards on `PAYMENT_AUTHORIZED`. Wait until `CONFIRMED`
  at the earliest; mature only after the clawback window.
- Showing matured-value rewards to the user before the window
  closes. Show "pending" clearly until POSTED.
- Shipping referral without anti-fraud. Every referral program
  without a fraud gate gets abused within weeks.
- Treating `LOYALTY_REWARD` as a pricing `DISCOUNT` rule. It is a
  tender.
- Running maturation inside the booking saga. Maturation is a
  batch worker; the saga is the hot path.
- **Earning rewards on booking gross value by default.** Rewards
  must earn on `recognized_margin`. Gross-based earning silently
  erodes the margin on thin-margin bookings and punishes
  rate-protected hotels.
- **Posting a `HOTEL_FUNDED` reward without a `RewardCampaign` +
  signed `funding_agreement_ref` + approver.** The ledger write is
  rejected in this case — an architectural invariant, not a
  validation rule you can route around.
- **Computing `recognized_margin` from live Stripe fees.** Use a
  bracket estimate at accrual; reconcile at capture. Ledger is
  truth; Stripe is a rail.

## 8. Observability

- Daily accrual total per tenant, per program, per status.
- Maturation worker runtime + lag (pending accruals past their
  maturation date).
- Referral funnel (ISSUED → SIGNED_UP → BOOKED → MATURED) with
  drop-off at each state.
- Anti-fraud decision distribution (hard-blocked / flagged /
  clean) and reviewer backlog.
- Clawback rate (matured-then-reversed / total-matured). A sudden
  spike signals either real-world churn or an anti-fraud miss.

## 9. Out of scope

- Multi-level referral (referrer of referrer). One level only.
- Tier-based earn rates as a primitive. Tier is a derived view
  from accrual history; earn rules scope on account_type or
  explicit account_id, and tenants can express tiered behavior
  via priority/scope combinations until a tier primitive is
  clearly needed (Phase 4+).
- Cashback conversion (reward → cash). Jurisdictional implications;
  not launching by default.

## 10. UX inspiration — what strong travel reward programs get right

Travel-specific reward programs (regional OTAs, super-app wallets,
loyalty-first booking products) teach a handful of patterns that
translate well to our margin-based economics. The **mechanisms** we
borrow; the **inputs** stay different (margin, not spend).

### 10.1 Simple public-facing tiers

Users do not read earn-rule specificity tables. They read three or
four tier names and a one-line description per tier. Tiers become a
`TIERED` multiplier over the margin-based base rule:

- **Explorer** — default. ×1.0 multiplier. Everyone starts here.
- **Frequent** — reached at N qualifying stays or M rewardable
  margin in the trailing 12 months. ×1.25.
- **Elite** — top segment. ×1.5 plus soft perks (better support
  queue, select direct-contract visibility, early campaign
  access).

Tier state is a derived view of accrual history, not a stored
field; the rewards module exposes `currentTier(account)` as a
read-only query. Tier qualification thresholds are tenant-
configurable.

### 10.2 Easy redemption at booking

The buyer should see, on the checkout page, **in points *and* in
booking currency**, how much reward is applicable and the maximum
they can redeem on this booking. One checkbox — "apply all
available loyalty" — should work for 80% of cases. The tender
composition (§6) already supports this; the UX surface is what
matters.

Key behaviors borrowed from strong programs:

- Reward balance visible on every page, not hidden in an account
  menu.
- Redemption amount pre-filled to the maximum the `TenderPolicy`
  allows, with a slider or input if the buyer wants less.
- No "min 5000 points to redeem" friction if the floor is below
  typical wallet balance — minimum redemption thresholds exist but
  should be set conservatively.

### 10.3 Post-completion crediting, visibly

Buyers tolerate a wait if the wait is **visible and honest**. After
booking, the UI shows:

```
Loyalty earned: 42 points  (pending — will credit after
                            your stay + 7 days)
```

And on the wallet page:

```
Pending maturations:
  +42 pts   booking #B-10234   matures 2026-06-14
  +18 pts   booking #B-10198   matures 2026-05-30

Available to redeem: 316 pts  (~ USD 31.60)
```

"Available to redeem" is **only** the POSTED balance. Pending
balances are visible but non-spendable. This is the pattern that
builds trust: visible accrual + honest maturation timeline + no
fine-print surprises.

### 10.4 Wallet-style clarity

Rewards, promo credit, and (eventually) cash wallet should all
appear in one unified "wallet" view, with each book clearly
labeled. Users should see:

```
Your wallet
  Loyalty         316 pts    (~ USD 31.60)
  Referral        200 pts    (~ USD 20.00)
  Promo credit    USD 50.00
  Cash wallet     USD 0.00   (coming soon)
```

Each book is a separate `WalletAccount` (ADR-012); the unification
is UI, not ledger. The user should never have to learn our internal
book taxonomy.

### 10.5 Lifetime points as a loyalty signal

Strong programs surface **lifetime accrual** (total ever earned,
not current balance) as the qualification signal for elite tiers.
This rewards long-term buyers even if they redeem aggressively.
Derivable from ledger history; no new primitive needed. Surface
it in the tier-progress UI.

### 10.6 What we deliberately do *not* borrow

- **Spend-based points.** Point value anchored to booking spend
  (e.g. "1 point per USD spent") is the norm in airline and hotel
  programs, but it assumes a margin structure we do not have. Our
  margin varies by source, rate class, and hotel; earning on spend
  would bleed thin-margin bookings. We borrow the UX feel of
  "points per booking" via `FIXED_REWARD_BY_MARGIN_BRACKET`, which
  presents as clean round numbers to the buyer while still being
  margin-aware under the hood.
- **Gamification** (streaks, badges, leaderboards). Explicitly out
  (CLAUDE.md §6).
- **Complex family/group pooling.** Out for MVP; one account, one
  wallet.
- **Opaque devaluation** (silently changing point-to-currency
  ratios after accrual). Our ratios are configuration, logged, and
  any change is forward-looking only.
