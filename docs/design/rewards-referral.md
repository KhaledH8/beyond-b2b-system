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

Default loyalty earn rule (starter kit for new tenants):

- `PERCENT_OF_NET`: 2% of booking net value.
- Scope: `tenant=<tenant>, account_type=B2C`.
- Caps: max 100 USD-equivalent per booking.
- Clawback window: 7 days after checkout.

Tenants can add more specific rules with higher earn rates per
account tier, supplier, destination, or campaign. Specificity-score
resolution (mirroring ADR-004 pricing rules) picks the best match.

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
