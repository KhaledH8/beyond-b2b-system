# ADR-018: Reseller collections, balances, reserves, and payouts

- **Status:** Accepted
- **Date:** 2026-04-21
- **Supersedes:** nothing
- **Amends:** ADR-012 (payments, wallet, credit ledger, payouts — adds
  reseller-earnings book with a pending/available/reserved/paid_out/
  clawed_back lifecycle, adds withdrawal pipeline, clarifies that
  withdrawable cash earnings are a distinct book from non-withdrawable
  platform credits), ADR-017 (reseller billing, resale controls, branded
  documents — adds `ResellerSettlementMode` to the `ResellerProfile`
  shape and splits reseller onboarding into legal-entity KYC and payout-
  account verification)
- **Depends on:** ADR-006 (tenancy/accounts), ADR-012 (wallet ledger),
  ADR-016 (legal documents), ADR-017 (reseller capability)

## Context

ADR-017 introduced reselling as a capability. A reseller buys from us
at `bb_sell_to_reseller_amount` and sells to a guest at
`reseller_resale_amount`, and we explicitly refused to record the
guest-facing amount in our ledger. That was and remains correct when
the reseller collects the guest payment themselves.

The new requirement breaks that symmetry. Some resellers — particularly
subscriber-group operators and smaller agencies that do not want to
run card acquiring — want **Beyond Borders to collect money from the
guest on the reseller's behalf**, net out what they owe us, and
periodically pay out the remainder. This is a materially different
commercial and legal model than "reseller pays us on credit or card and
settles their own guest separately."

The naive path — "just let any reseller opt in, credit them a
withdrawable wallet, and wire Stripe Connect payouts" — is wrong on
three axes:

1. **Legal.** A withdrawable cash balance payable to a third party is
   a regulated liability in most jurisdictions (safeguarding, e-money,
   marketplace facilitator rules). It requires a verified legal entity
   on the other side, not "a person with an account."
2. **Risk.** Guest refunds, chargebacks, supplier no-shows, and
   fraud can arrive *after* the reseller has been paid out. Without
   holds and reserves, clawbacks become collections problems.
3. **Product.** Not every reseller wants payouts. Many are fine with
   earnings accruing as **non-withdrawable platform credit** usable on
   future bookings, and that is genuinely lower-friction for them and
   lower-liability for us.

Two reseller collection/settlement models are therefore first-class:

- **`CREDIT_ONLY`** — Beyond Borders collects from the guest. The
  reseller's net earnings post to a non-withdrawable platform-credit
  book that can only be spent on future bookings through our platform.
- **`PAYOUT_ELIGIBLE`** — Beyond Borders collects from the guest. The
  reseller's net earnings move through a pending → available →
  (optionally) paid_out lifecycle and, subject to KYC and a verified
  payout account, can be withdrawn as cash to the reseller's external
  bank account.

A third mode — **`RESELLER_COLLECTS`** — the ADR-017 default — remains.
Beyond Borders does not touch guest money; the reseller is billed
directly per their `BillingProfile` and `CreditLine` (ADR-012). No
earnings book, no payout pipeline. This ADR does not change that flow.

## Decision

### Three reseller settlement modes, explicitly typed

`ResellerSettlementMode` is a first-class, versioned property of every
`ResellerProfile`. It is not derived from account type, KYC state, or
payout-account presence — those are **inputs** that gate what modes the
profile is *allowed* to hold.

```
ResellerSettlementMode enum {
  RESELLER_COLLECTS       // default; ADR-017 flow unchanged
  CREDIT_ONLY             // BB collects; earnings non-withdrawable
  PAYOUT_ELIGIBLE         // BB collects; earnings withdrawable, gated
}
```

Key invariants:

- Every `ResellerProfile` has exactly one active
  `ResellerSettlementMode`. Default on create is `RESELLER_COLLECTS`.
- Transitioning from `RESELLER_COLLECTS` → (`CREDIT_ONLY` |
  `PAYOUT_ELIGIBLE`) requires operational approval and the gating
  checks below.
- Transitioning to `PAYOUT_ELIGIBLE` requires strictly more evidence
  than `CREDIT_ONLY`: a verified legal entity, a verified payout
  account, accepted payout terms, and (per jurisdiction) a KYC/KYB
  review outcome of `APPROVED`.
- Downgrade (`PAYOUT_ELIGIBLE` → `CREDIT_ONLY` or `RESELLER_COLLECTS`)
  is always permitted and never loses earnings; open withdrawals
  continue under the previous mode's terms or are cancelled per
  policy, never silently converted.

### Separate books, distinct liabilities

Two new balance types on `WalletAccount` (ADR-012), one per mode with
earnings:

| Balance type | Mode | Liability kind | Withdrawable | Expires |
|---|---|---|---|---|
| `RESELLER_PLATFORM_CREDIT` | `CREDIT_ONLY` | platform credit (non-cash) | No | May expire per policy |
| `RESELLER_CASH_EARNINGS` | `PAYOUT_ELIGIBLE` | cash payable | Yes (through payout pipeline) | Never auto-expires |

These are **distinct books** from `CASH_WALLET`, `PROMO_CREDIT`,
`LOYALTY_REWARD`, `REFERRAL_REWARD`, `AGENCY_CREDIT`,
`CORPORATE_CREDIT`. The ADR-012 rule — "separate books, same ledger
machinery, never a single total balance" — applies verbatim.

Rationale for keeping them separate:

- `RESELLER_PLATFORM_CREDIT` is **our liability to ourselves**: the
  reseller can only redeem it on our platform, so from a regulatory
  perspective it resembles issued platform credit (like
  `PROMO_CREDIT`), not safeguarded customer cash.
- `RESELLER_CASH_EARNINGS` is a **cash payable** to a verified
  third-party legal entity. It has safeguarding, segregation, and in
  some jurisdictions e-money / marketplace-facilitator implications.
- Mixing them destroys the legal audit trail. A migration path from
  `CREDIT_ONLY` to `PAYOUT_ELIGIBLE` does **not** rewrite historical
  credit entries into cash; going forward, new earnings post to the
  cash book, old credit stays in the credit book and can be redeemed
  by booking.

### Earnings state machine (PAYOUT_ELIGIBLE mode)

```
           (guest pays, booking CONFIRMED)
                     │
                     ▼
                  pending   ──(clawback window expires)──►  available
                     │                                            │
                     │◄──(refund / chargeback / fraud)──┐         │
                     │                                  │         │
                     ▼                                  │         ▼
               clawed_back                       reserved ◄── (risk hold,
                                                       │      reserve %)
                                                       │         │
                                                       └─────────┤
                                                                 ▼
                                                   (WithdrawalRequest
                                                    APPROVED, PayoutBatch
                                                    sent, transfer.paid)
                                                                 │
                                                                 ▼
                                                             paid_out
```

- **`pending`** — `RESELLER_CASH_EARNINGS` accrues as a `PENDING`
  ledger entry when the booking confirms. It is not yet available for
  withdrawal. The pending window is per-tenant and per-reseller
  configurable (default: stay end + refund cutoff, conservatively set
  per jurisdiction).
- **`available`** — pending graduates to available when the pending
  window closes and no refund/chargeback/fraud signal has landed.
  Available balance is eligible for withdrawal or, where policy
  allows, for redemption on future bookings.
- **`reserved`** — a portion of available (or of newly-accruing
  pending) may be held back per `ReserveBalance` rules — rolling
  percentage reserve, chargeback-history reserve, high-risk category
  reserve, fresh-account ramp-up reserve. Reserved funds are still
  the reseller's, accounted as payable, but not withdrawable until
  released.
- **`paid_out`** — once a `WithdrawalRequest` is approved and a
  `PayoutBatch` has settled against the reseller's `PayoutAccount`
  (Stripe Connect transfer success, bank-rail confirmation, or
  equivalent rail event), the ledger marks the corresponding
  available slice as paid_out. The payable is extinguished.
- **`clawed_back`** — a refund, chargeback, dispute loss, supplier
  no-show, or fraud decision posts a compensating entry. If pending,
  it reduces pending. If available, it reduces available. If already
  paid_out, it creates a `RefundLiabilityRule` debt on the reseller's
  book (negative available, recoverable by netting future earnings
  or by collections per contract). Clawbacks are visible as discrete
  state, not silent balance adjustments.

Every transition is a `LedgerEntry` under ADR-012 machinery. The
state values are not a separate persisted enum — they are **derived
from ledger rows and their `status` + `kind` + age**. The
`RESELLER_EARNINGS_*` ledger kinds listed below encode the
transitions; balance views project them into the five states.

### New ledger entry kinds

Extends the `LedgerEntry.kind` enum from ADR-012 (additive):

```
RESELLER_EARNINGS_ACCRUAL        // pending earning posted on booking confirm
RESELLER_EARNINGS_MATURATION     // pending → available
RESELLER_EARNINGS_CLAWBACK       // refund, chargeback, dispute loss, fraud
RESELLER_EARNINGS_RESERVE_HOLD   // available → reserved
RESELLER_EARNINGS_RESERVE_RELEASE // reserved → available
RESELLER_EARNINGS_WITHDRAWAL_HOLD // available → pending-payout (during batch)
RESELLER_EARNINGS_PAID_OUT       // pending-payout → paid_out on transfer success
RESELLER_EARNINGS_WITHDRAWAL_REVERSAL // payout rail failure reverses the hold
RESELLER_CREDIT_ACCRUAL          // CREDIT_ONLY mode: earnings post as platform credit
RESELLER_CREDIT_REDEMPTION       // platform credit spent on future booking (tender)
RESELLER_CREDIT_CLAWBACK         // refund reverses platform-credit accrual
RESELLER_CREDIT_EXPIRY           // policy-driven expiry of non-withdrawable credit
```

ADR-012 invariants (append-only, double-entry, idempotency,
single-currency per wallet) apply unchanged.

### Earning amount — what actually accrues

When a `PAYOUT_ELIGIBLE` or `CREDIT_ONLY` reseller closes a booking and
Beyond Borders collected the guest payment, the amount accrued to the
reseller is:

```
earning = guest_paid_amount
        - bb_sell_to_reseller_amount   // what the reseller owes us
        - bb_platform_fee              // contractual commission / service fee
        - per_tenant_tax_withholding?  // jurisdiction-driven, policy-owned
        - per_reseller_reserve_hold?   // ReserveBalance rule application
```

Notes:

- `bb_sell_to_reseller_amount` continues to be a ledger `SPEND` entry
  on our revenue-recognition books exactly as today (ADR-012). It is
  not double-counted.
- `bb_platform_fee` is a commercial parameter on the reseller's
  contract. It is settled into a platform revenue book as part of the
  same double-entry event — the reseller's earning is `net of` fee,
  never "gross with a separate fee invoice."
- The `guest_paid_amount` equals whatever the guest actually paid via
  the BB-controlled collection rail for the reseller-channel booking.
  It is **not** `reseller_resale_amount` by definition (ADR-017
  still owns what the reseller displayed); in practice they equal
  each other at confirmation time, but the earning formula uses
  `guest_paid_amount` so that partial payments, tips, or currency
  rounding are handled by what actually landed in our account.
- The earning does **not** include loyalty/referral rewards earned
  by the guest on the booking — those are the guest's, on the guest's
  wallet, per ADR-014.

### New entities

```
ResellerSettlementMode
  ----------------------
  A first-class enum on ResellerProfile (not a separate table).
  { RESELLER_COLLECTS | CREDIT_ONLY | PAYOUT_ELIGIBLE }
  Carried with version and effective_from on the ResellerProfile row
  (versioned the same way BillingProfile is versioned — prior bookings
  always see the mode that applied at their confirmation time).
```

```
ResellerKycProfile {
  kyc_profile_id
  tenant_id
  reseller_profile_id
  legal_entity_kind          // SOLE_TRADER | LLC | CORPORATION |
                             //   PARTNERSHIP | NON_PROFIT |
                             //   INDIVIDUAL_NOT_BUSINESS
  legal_entity_name
  registration_number
  registration_jurisdiction
  beneficial_owners[] {
    name, dob, nationality,
    id_document_ref, address,
    ownership_percent
  }
  directors_or_controllers[] { name, role, id_document_ref }
  business_address { line1, line2, city, region, postal_code, country }
  business_website?
  business_activity_code?    // NACE / ISIC / etc.
  aml_risk_rating            // LOW | MEDIUM | HIGH | PROHIBITED
  pep_screen_result          // CLEAR | HIT | REVIEW
  sanctions_screen_result    // CLEAR | HIT | REVIEW
  review_status              // NOT_STARTED | IN_REVIEW | APPROVED |
                             //   REJECTED | SUSPENDED
  reviewer_id
  approved_at?, rejected_reason?
  evidence_document_ids[]    // uploaded IDs, registration docs,
                             //   utility bills, ownership certs
  version, effective_from
}
```

`ResellerKycProfile.review_status = APPROVED` is a **necessary but
not sufficient** condition for `PAYOUT_ELIGIBLE`. Sufficient also
requires at least one active, verified `PayoutAccount`, accepted
payout terms (contract), and an operational approval.
`INDIVIDUAL_NOT_BUSINESS` is **never** accepted for
`PAYOUT_ELIGIBLE` in MVP; a natural person cannot be payout-eligible
without a business legal entity. They remain eligible for
`CREDIT_ONLY` or `RESELLER_COLLECTS`.

```
PayoutAccount {
  payout_account_id
  tenant_id
  reseller_profile_id
  rail                        // STRIPE_CONNECT | BANK_TRANSFER_SWIFT |
                              //   BANK_TRANSFER_LOCAL | FUTURE_RAIL
  rail_external_id?           // e.g. Stripe connected-account id
  account_holder_name         // must match KYC legal_entity_name
  account_country
  account_currency
  iban?, bic?, account_number?, routing_number?
  micro_deposit_verified_at?  // where the rail supports it
  verification_status         // UNVERIFIED | PENDING | VERIFIED |
                              //   FAILED | SUSPENDED
  verification_evidence_ref?
  activated_at?
  deactivated_at?
  deactivation_reason?
  status                      // ACTIVE | INACTIVE | RETIRED
  version, effective_from
}
```

A reseller may hold multiple `PayoutAccount`s (e.g. different
currencies). For a given payout currency, exactly one is
`ACTIVE`. Changing the active account for a currency requires
re-verification. Account holder name divergence from
`ResellerKycProfile.legal_entity_name` is a hard reject on
verification.

```
PendingEarnings           // view, not a table — projects
                          //   RESELLER_CASH_EARNINGS ledger rows
                          //   with status=PENDING and no
                          //   MATURATION row yet
AvailableEarnings         // view — matured accruals net of holds
                          //   and reversals, not yet in-flight for
                          //   withdrawal, not paid_out
```

Both are derivable from the ledger; a cached row may exist for
fast reads per ADR-012's `BalanceSnapshot` pattern.

```
ReserveBalance {
  reserve_balance_id
  tenant_id
  reseller_profile_id
  currency
  kind                      // ROLLING_PERCENT_RESERVE |
                            //   FIXED_FLOOR_RESERVE |
                            //   CHARGEBACK_HISTORY_RESERVE |
                            //   RISK_TIER_RESERVE |
                            //   NEW_RESELLER_RAMP_RESERVE
  params {
    percent_basis_points?
    floor_minor?
    rolling_window_days?
    ramp_decay_per_month?
    ...
  }
  held_minor_units          // derived; sum of active RESERVE_HOLD -
                            //   RESERVE_RELEASE
  status                    // ACTIVE | RETIRED
  version, effective_from
}
```

Multiple `ReserveBalance` rules can be active for one reseller
(e.g. a new-reseller ramp reserve plus a chargeback-history
reserve). They stack; the total held is the sum. Releases
happen on schedule (rolling window) or on event (clean
chargeback run).

```
WithdrawalRequest {
  withdrawal_request_id
  tenant_id
  reseller_profile_id
  payout_account_id
  currency
  requested_minor_units
  eligible_minor_units       // computed: min(requested, available -
                             //   reserved - minimums)
  fee_minor_units            // payout-rail fee, if passed through
  status                     // SUBMITTED | UNDER_REVIEW |
                             //   APPROVED | REJECTED |
                             //   IN_PAYOUT_BATCH | PAID | FAILED |
                             //   CANCELLED
  submitted_at
  reviewer_id?
  decision_reason?
  linked_payout_batch_id?
  rail_reference?            // e.g. Stripe transfer id
  created_at, updated_at
}
```

Approval of a `WithdrawalRequest` posts
`RESELLER_EARNINGS_WITHDRAWAL_HOLD` against available, which is
the atomic reservation preventing the same dollars from being
withdrawn twice.

```
PayoutBatch {
  payout_batch_id
  tenant_id
  currency
  rail                       // STRIPE_CONNECT | BANK_TRANSFER_SWIFT | ...
  total_minor_units
  status                     // BUILDING | SUBMITTED | PARTIALLY_PAID |
                             //   PAID | FAILED
  items[] {
    withdrawal_request_id
    reseller_profile_id
    payout_account_id
    amount_minor_units
    rail_reference?
    item_status              // PENDING | PAID | FAILED | RETRYING
    failure_reason?
  }
  submitted_at, settled_at?
  created_by
}
```

One `WithdrawalRequest` belongs to at most one `PayoutBatch`. A
`PayoutBatch` may span many withdrawals but one currency and one
rail.

```
RefundLiabilityRule {
  rule_id
  tenant_id
  reseller_profile_id?        // null = tenant default
  applies_to_mode[]           // CREDIT_ONLY | PAYOUT_ELIGIBLE
  refund_order_of_recovery    // list ordered: RESERVED, AVAILABLE,
                              //   PENDING, NEGATIVE_AVAILABLE,
                              //   EXTERNAL_COLLECTIONS
  chargeback_order_of_recovery
  allow_negative_available    // bool — may reseller earnings go
                              //   negative? true for PAYOUT_ELIGIBLE
                              //   where contract permits; false by
                              //   default for CREDIT_ONLY
  negative_cap_minor?         // hard floor on negative balance
  escalation_threshold_minor? // triggers ops review when negative
                              //   exceeds this
  status                      // ACTIVE | RETIRED
  version, effective_from
}
```

Every refund or chargeback against a reseller-channel booking
selects a `RefundLiabilityRule` for the reseller + mode and
deducts in the stated order. This makes the post-payout clawback
case explicit policy, not implicit accounting hack.

### Hard gating rules (who may become what)

| Gate | RESELLER_COLLECTS | CREDIT_ONLY | PAYOUT_ELIGIBLE |
|---|---|---|---|
| `ResellerProfile.status = ACTIVE` | required | required | required |
| `BillingProfile` (ADR-017) | required | required | required |
| `TaxProfile` (ADR-017) | required | required | required |
| `ResellerKycProfile.review_status = APPROVED` | not required | **required** | **required** |
| `legal_entity_kind ≠ INDIVIDUAL_NOT_BUSINESS` | n/a | not required (contract-dependent) | **required** |
| At least one `PayoutAccount.verification_status = VERIFIED` in the earnings currency | n/a | n/a | **required** |
| Signed payout-terms contract version accepted | n/a | n/a | **required** |
| Sanctions / PEP screening `CLEAR` | n/a | **required** | **required** |
| AML risk rating ≠ `PROHIBITED` | n/a | **required** | **required** |
| Ops approval action recorded (actor + reason) | not required | required | **required** |

These gates are enforced at **mode transition time** and re-validated
on every withdrawal request approval. A KYC lapse (expired document,
adverse re-screening) auto-suspends `PAYOUT_ELIGIBLE` back to
`CREDIT_ONLY`; pending earnings continue to accrue into the cash
book but no new withdrawals are approvable until review clears.

### BB as the collection party — impact on ADR-012 and ADR-017

- **Ledger side.** ADR-012 `SPEND` for
  `bb_sell_to_reseller_amount` continues to post on reseller-channel
  bookings exactly as before. New: the `TOPUP` from the guest's
  card settlement no longer routes to a B2C `CASH_WALLET`; it
  routes to a **platform collections suspense** internal book
  (`reseller_collections_suspense`), from which the double-entry
  event splits into (a) revenue recognition for
  `bb_sell_to_reseller_amount`, (b) platform fee recognition for
  `bb_platform_fee`, and (c) accrual to the reseller's earnings
  or credit book. No silent transfers; every component is a ledger
  row.
- **Document side.** The guest still receives the reseller-branded
  `RESELLER_GUEST_CONFIRMATION` / `RESELLER_GUEST_VOUCHER` (ADR-017),
  showing `reseller_resale_amount` — unchanged. The BB `TAX_INVOICE`
  from Beyond Borders to the reseller continues to exist for the
  `bb_sell_to_reseller_amount` leg — unchanged.
- **No new consumer-facing tax document.** The guest-to-reseller leg's
  tax treatment remains the reseller's problem on their own books
  (ADR-017 anti-pattern: embedding guest-to-reseller tax logic here).

### Stripe and payout rails

Stripe Connect (ADR-012) remains the default Stripe product.
`PAYOUT_ELIGIBLE` resellers get a connected Stripe account via the
platform's Connect model; `PayoutAccount.rail_external_id` holds the
connected-account id. The payout pipeline:

1. `WithdrawalRequest` SUBMITTED → review.
2. APPROVED → `RESELLER_EARNINGS_WITHDRAWAL_HOLD` posted.
3. Batched into a `PayoutBatch` on the scheduled cadence.
4. `PayoutBatch` SUBMITTED → Stripe Connect `transfer.created` per item.
5. Stripe webhook `transfer.paid` → `RESELLER_EARNINGS_PAID_OUT`.
6. Stripe webhook `transfer.failed` → `RESELLER_EARNINGS_WITHDRAWAL_REVERSAL`
   and the `WithdrawalRequest` flips to FAILED; the held earning
   returns to available.

Non-Stripe rails (local bank transfers in markets where Connect is
unsupported) share the same lifecycle with rail-specific adapters.
The ledger is rail-agnostic.

### Configurable parameters (per tenant, with per-reseller overrides)

- Pending window (default: booking stay-end + jurisdictional refund
  cutoff).
- Minimum withdrawal amount.
- Withdrawal cadence (on-demand / weekly / monthly).
- Rolling reserve percentage and window.
- Reserve ramp schedule for new resellers.
- Negative-available cap.
- Platform-credit expiry rules (for `CREDIT_ONLY` mode).
- Jurisdictional tax-withholding rules (where applicable).

Defaults ship conservative. Per-reseller overrides require ops approval.

## Consequences

- The reseller model now carries **three clearly-typed settlement
  modes** and a real earnings lifecycle. What used to be an unsafe
  "credit them a number and wire it later" becomes a ledger-native,
  auditable flow with discrete states.
- Withdrawal risk (refunds, chargebacks, clawbacks after payout) is
  modelled as explicit `RefundLiabilityRule` policy plus
  `ReserveBalance` holds. Ops has levers; finance has a clean audit
  trail; legal has named profiles per reseller.
- `CREDIT_ONLY` becomes a safe default that does not require KYC to
  the payout-eligible standard, lowering the onboarding bar for
  small resellers and subscriber groups while keeping us clear of
  cash-payout liabilities.
- `PAYOUT_ELIGIBLE` requires strictly more evidence than
  `CREDIT_ONLY`. This is deliberate. The model intentionally forces
  us to say *no* until the inputs exist.
- ADR-012's ledger machinery absorbs the new books and kinds without
  structural change — the decision to make `WalletAccount` balance-
  typed rather than a single pool pays off here.

## Anti-patterns explicitly forbidden

- **Treating reseller earnings as a number on the `ResellerProfile`
  row.** Balance is derived from ledger rows. Same rule as ADR-012.
- **Mixing `RESELLER_PLATFORM_CREDIT` and `RESELLER_CASH_EARNINGS`
  into a single "reseller wallet."** They are different liabilities
  with different legal weight; one is platform credit, the other is
  cash payable to a third-party legal entity.
- **Paying out to a reseller without a verified `PayoutAccount` in
  the earnings currency.** No payout rail may be invoked without a
  VERIFIED PayoutAccount whose account holder name matches the KYC
  legal entity name.
- **Allowing an `INDIVIDUAL_NOT_BUSINESS` KYC profile to graduate to
  `PAYOUT_ELIGIBLE` in MVP.** Natural persons with no business
  registration do not receive cash payouts from us.
- **Converting `RESELLER_PLATFORM_CREDIT` balances into withdrawable
  cash on mode upgrade.** Old credit stays credit. Only new accruals
  after the mode flip post to the cash book.
- **Silently netting a post-payout clawback without a
  `RefundLiabilityRule`.** Negative-available is a modelled state,
  not an accounting surprise.
- **Running withdrawals outside a `PayoutBatch`.** Even a
  single-request payout must have a one-item batch record for
  reconciliation against the rail.
- **Using guest-facing amounts we never collected as an earning
  base.** The earning formula uses `guest_paid_amount` (what
  actually hit the BB collection rail), not
  `reseller_resale_amount` (which is a document property per
  ADR-017).
- **Auto-expiring `RESELLER_CASH_EARNINGS`.** Cash earnings do not
  expire; only non-withdrawable platform credit can expire per
  policy.
- **Accruing reseller earnings on a `PROPERTY_COLLECT` or
  `UPSTREAM_PLATFORM_COLLECT` booking (ADR-020).** We never
  collected the guest's money, so there is no earning to accrue.
  `CREDIT_ONLY` and `PAYOUT_ELIGIBLE` apply only when
  `CollectionMode = BB_COLLECTS`; `PROPERTY_COLLECT` and
  `UPSTREAM_PLATFORM_COLLECT` rates are filtered out of reseller
  listings at source selection.

## Open items

- **Jurisdictional payout licence review.** Whether operating the
  payout pipeline in a given country requires us to hold a payment-
  institution / e-money / marketplace-facilitator licence is a per-
  jurisdiction legal question. `PAYOUT_ELIGIBLE` does not enable in
  production for a jurisdiction until legal clearance is recorded
  against that tenant + country combination. Launch sequencing:
  `RESELLER_COLLECTS` everywhere, then `CREDIT_ONLY`, then
  `PAYOUT_ELIGIBLE` per-jurisdiction.
- **KYC provider selection.** KYC/KYB document capture, sanctions
  and PEP screening, and ongoing monitoring are a provider
  integration (Sumsub / Onfido / Persona / equivalent). Provider
  choice is Phase 3 commercial.
- **Tax withholding.** Whether we withhold tax at payout in specific
  jurisdictions (e.g. US 1099-K style reporting, VAT on platform
  fee, GCC withholding edges) is a tax-engine concern and is
  deferred to the tax-engine ADR.
- **Reseller-initiated withdrawal UI.** Reseller self-serve
  withdrawal in the B2B portal is Phase 4. MVP is platform-admin
  initiated, on a scheduled cadence.
- **Chargeback operational playbook.** Dispute handling, evidence
  gathering, and reseller-facing dispute workflow are an
  operations-tooling deliverable, not an architectural one, and
  land with Phase 4.
- **Multi-currency earnings and FX on payout.** MVP requires the
  earning currency and payout currency to match. Cross-currency
  payouts with explicit FX entries are Phase 4+.
- **`PAYOUT_ELIGIBLE` launch gate.** The withdrawable cash wallet
  liability question from ADR-012's open items (`CASH_WALLET`
  regulatory review) extends to `RESELLER_CASH_EARNINGS`. Do not
  launch `PAYOUT_ELIGIBLE` in production until that review clears
  for the operating jurisdiction.
