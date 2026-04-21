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
