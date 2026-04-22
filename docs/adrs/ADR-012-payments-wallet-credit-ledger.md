# ADR-012: Payments, wallet, credit ledger, and payouts

- **Status:** Accepted
- **Date:** 2026-04-21
- **Supersedes:** nothing
- **Amends:** ADR-004 (pricing — wallet is a tender, not a pricing rule),
  ADR-010 (booking orchestration — new tender resolution step and reward
  accrual step)

## Context

The platform now requires:

- A **wallet** for both B2C and B2B, holding multiple distinct balance
  types (cash, promo credit, loyalty, referral, agency credit).
- A **payment gateway** (Stripe) that acts as a money-movement rail, not
  as the wallet itself.
- B2B **credit / pay-later** support (agency credit lines, corporate
  invoice terms).
- Future **marketplace payouts** (tenant-of-tenant resale, agency
  subscriber payouts, partner commissions).

A prior assumption that Stripe Customer Balance or Stripe Treasury could
serve as the wallet is explicitly rejected here:

- Stripe Customer Balance only models one pooled credit per Stripe
  Customer. We need multiple, typed, rule-governed balances per account
  with independent lifecycle (expiry, clawback, redemption rules).
- Stripe Treasury is US-focused and not suitable for UAE/MENA operations.
- Holding customer cash as a stored-value balance has regulatory weight
  (safeguarding, segregation). Whichever jurisdiction we operate in, the
  wallet must be **our ledger of record** so we can reason about
  liabilities independently of the payment processor.

## Decision

### The wallet is an internal double-entry ledger

A wallet is not a number stored on an account row. It is a **view
computed from an append-only ledger** of entries. Balances are derived,
never written directly.

### Balance types (separate books, same ledger machinery)

Each `Account` (ADR-006) may have zero or more `WalletAccount` rows, one
per `(balance_type, currency)`:

| Balance type | Who holds it | Key rules |
|---|---|---|
| `CASH_WALLET` | B2C, B2B | Customer-funded. Refundable. Treated as segregated liability. |
| `PROMO_CREDIT` | Any | Granted by us. Non-refundable as cash. May expire. Redemption-restricted. |
| `LOYALTY_REWARD` | B2C + eligible B2B | Earned via bookings per ADR-014. Pending → matured lifecycle. |
| `REFERRAL_REWARD` | B2C primary | Earned via referrals per ADR-014. Anti-fraud gated. |
| `AGENCY_CREDIT` | AGENCY accounts | Negative-balance allowed up to credit limit. Settled via invoice. |
| `CORPORATE_CREDIT` | CORPORATE accounts | Same machinery as agency credit, different policies. |

Each balance type is a **separate book**. A single "total balance" is not
a concept — redemption rules differ per type and mixing them destroys
the audit trail.

### LedgerEntry shape

```
LedgerEntry {
  entry_id            // opaque ULID, never reused
  tenant_id
  wallet_account_id   // which book this posts to
  amount_minor_units  // signed; negative = debit, positive = credit
  currency
  kind:
    TOPUP              // cash in (B2C top-up, B2B prepayment)
    SPEND              // booking consumption
    REFUND             // cash out
    PROMO_GRANT        // we grant promo credit
    PROMO_REVOKE       // promo expiry or admin revoke
    REWARD_ACCRUAL     // loyalty/referral pending posting
    REWARD_MATURATION  // pending → matured (usable)
    REWARD_CLAWBACK    // cancellation or fraud reversal
    REWARD_REDEMPTION  // spent as tender on a booking
    CREDIT_DRAWDOWN    // B2B credit used
    CREDIT_SETTLEMENT  // B2B invoice paid
    ADJUSTMENT         // ops correction, requires reason + approver
  status: PENDING | POSTED | VOIDED
  source_ref {
    type: BOOKING | PAYMENT_INTENT | CAMPAIGN | REFERRAL | INVOICE | MANUAL
    id
  }
  idempotency_key     // deterministic per source event
  posted_at           // null until POSTED
  created_at, created_by, notes
}
```

### Invariants

1. **Append-only.** Entries are never updated after POSTED except status
   transitions (POSTED → VOIDED via compensating entry pair).
2. **Double-entry.** Every business event produces balanced entry pairs
   — e.g., `SPEND` debits `CASH_WALLET` and the offsetting credit lives
   on a `revenue_suspense` internal book. At least one entry pair per
   event, never orphan entries.
3. **Idempotency by construction.** The same source event (booking id +
   step) always produces the same `idempotency_key`. Re-posting is a
   no-op, not a double-post.
4. **Currency is explicit.** A wallet is single-currency. Cross-currency
   operations go through an explicit FX entry.
5. **Balance is derived.** A `balance_cache` row may be kept for fast
   reads but is rebuildable from entries at any time. The ledger is
   authoritative.

### Stripe's role — payment rail, not ledger

Stripe sits outside the wallet. Money flows:

- **B2C top-up / direct pay:** Stripe `PaymentIntent` → on capture,
  `LedgerEntry{kind: TOPUP}` posts to `CASH_WALLET` or direct-consumes
  as `SPEND` depending on flow.
- **Refund:** Stripe refund → `LedgerEntry{kind: REFUND}`.
- **Marketplace payouts (later):** Stripe Connect with **separate
  charges and transfers**. Platform charges the cardholder; a transfer
  to a connected account is recorded as a ledger movement from a
  platform-held book to the connected account's payable book. Suitable
  for agency payouts or tenant-of-tenant resale models.

Stripe Connect is the chosen Stripe product. Stripe Customer Balance is
explicitly **not** used as a wallet. Stripe Treasury is **not** used.

### Tender resolution at booking time

When a booking is priced, the total consists of one sellable amount
(ADR-004). At checkout, the buyer composes **tenders** to pay that
amount:

```
TenderComposition {
  lines: [
    { kind: WALLET_CASH,       wallet_account_id, amount }
    { kind: WALLET_PROMO,      wallet_account_id, amount }
    { kind: WALLET_LOYALTY,    wallet_account_id, amount }
    { kind: WALLET_REFERRAL,   wallet_account_id, amount }
    { kind: AGENCY_CREDIT,     credit_line_id,    amount }
    { kind: CORPORATE_CREDIT,  credit_line_id,    amount }
    { kind: CARD_PAYMENT,      stripe_intent_id,  amount }
    { kind: INVOICE,           invoice_cycle_ref, amount }
  ]
  sum must equal PricedOffer.total
}
```

Tender composition rules are per-tenant and per-account-type
configurable (e.g., promo credit capped at 30% of booking, loyalty
non-stackable with promo on the same booking, agency credit only for
AGENCY accounts). Rules live in `TenderPolicy`.

**Tender resolution is distinct from pricing.** Pricing produces the
sellable amount. Tender composition pays it. Neither mutates the other.

### B2B credit lines

```
CreditLine {
  credit_line_id
  tenant_id
  account_id            // AGENCY or CORPORATE
  currency
  limit_minor_units
  exposure_minor_units  // derived from CREDIT_DRAWDOWN - CREDIT_SETTLEMENT
  billing_cycle:        // MONTHLY | BIWEEKLY | ON_DEMAND
  terms:                // NET_7 | NET_15 | NET_30 | CUSTOM
  status:               // ACTIVE | SUSPENDED | CLOSED
  ...
}
```

- Booking against credit = `CREDIT_DRAWDOWN` ledger entry on the
  account's `AGENCY_CREDIT`/`CORPORATE_CREDIT` book.
- At cycle close, an invoice is generated summing drawdowns since last
  cycle. Payment clears via bank transfer or Stripe and posts
  `CREDIT_SETTLEMENT` entries.
- Exposure breaching limit blocks new drawdowns (surfaced to the user
  as "credit exhausted, use another tender").

### Payouts (platform resale future)

When tenant-of-tenant resale goes live (Phase 6), Stripe Connect
transfers pay out to connected accounts. The ledger mirrors this with
internal `PayoutBatch` records pointing to Stripe transfer ids. No
money-movement story lives only in Stripe — every transfer has a
ledger row.

### Webhook ingestion

Stripe webhooks (`payment_intent.succeeded`, `charge.refunded`,
`charge.dispute.created`, `transfer.*`) drive ledger writes
asynchronously. The webhook handler is idempotent (Stripe event id as
idempotency key).

## Consequences

- Payment processor churn becomes a rail swap, not a domain rewrite.
  If we ever move off Stripe for a region, only the rail adapter
  changes.
- Segregation of stored-value liabilities is trivially reportable —
  run the ledger and sum.
- Credit/invoice is not a bolt-on; it is the same ledger machinery
  with different kinds of entries.
- Operational cost: every booking-relevant event is a ledger write.
  Postgres handles this at MVP scale; revisit if hot-path contention
  appears (likely Phase 5+).

## Anti-patterns explicitly forbidden

- Storing a user's wallet balance as an integer on the `account` row.
- Using Stripe Customer Balance as the wallet.
- Mixing balance types into a single "credits" pool.
- Reading Stripe as truth during reconciliation disputes — our ledger
  is truth; Stripe is a rail whose events we ingest.
- Silently converting promo credit to cash on refund.

## Amendment 2026-04-22 (see ADR-016, ADR-017)

### Tax invoice is a document, not a ledger entry

The ledger (this ADR) records what we sold. The **tax invoice**
that represents that sale to the buyer is a `BookingDocument`
of type `TAX_INVOICE` (ADR-016), issued by a `LegalEntity`
(ADR-016) bound to the tenant and jurisdiction. The ledger is
truth; the invoice is a rendering of the truth.

Consequences:

- `LedgerEntry` does not carry an `invoice_number` field.
  Relationship to the invoice goes in the other direction:
  `BookingDocument.amounts` are derived from ledger + booking
  facts at issue time.
- Refunds continue to post `LedgerEntry{kind: REFUND}` as
  before. A `CREDIT_NOTE` (ADR-016 legal tax doc) is issued
  against the original `TAX_INVOICE` by the document-issue
  worker — not by the ledger.
- Credit-line invoicing (cycle close, `CREDIT_SETTLEMENT`)
  similarly emits `TAX_INVOICE` documents. The ledger fact is
  the settlement; the document is its legal rendering.

### Reseller channel: ledger records sell-to-reseller only

For reseller-channel bookings (ADR-017), the ledger records
`bb_sell_to_reseller_amount`. The reseller's guest-facing
resale amount is a document property on
`RESELLER_GUEST_CONFIRMATION` / `RESELLER_GUEST_VOUCHER` and
never appears as a `LedgerEntry`. The reseller's own accounting
of their markup lives on the reseller's own books, not ours.

### Invoice generation timing

Invoice generation previously listed as a Phase 3 open item is
resolved by ADR-016: the document-issue worker ships in Phase 2
for the Beyond Borders B2C flow (`TAX_INVOICE` +
`BB_BOOKING_CONFIRMATION` + `BB_VOUCHER`). Reseller-channel
invoice + branded guest documents ship in Phase 3 with the
reseller capability.

## Amendment 2026-04-21 (see ADR-018)

### Reseller collections, earnings books, and payouts

ADR-018 extends this ADR additively to cover reseller-channel
settlement where **Beyond Borders collects the guest payment on the
reseller's behalf**. ADR-017 continues to govern the default
`RESELLER_COLLECTS` case in which the reseller bills the guest
directly and settles with us via their `BillingProfile` /
`CreditLine` — that flow is unchanged. ADR-018 adds two additional
settlement modes:

- **`CREDIT_ONLY`** — BB collects the guest payment; the reseller's
  net earning accrues as **non-withdrawable platform credit**.
- **`PAYOUT_ELIGIBLE`** — BB collects the guest payment; the
  reseller's net earning accrues as **withdrawable cash earnings**,
  gated by KYC/KYB, sanctions / PEP screening, a verified
  `PayoutAccount`, and signed payout terms.

New `WalletAccount.balance_type` values (additive, same ledger
machinery):

- `RESELLER_PLATFORM_CREDIT` — reseller earnings in `CREDIT_ONLY`
  mode. Non-withdrawable, spendable on future platform bookings,
  may expire per policy. Treated as platform credit (like
  `PROMO_CREDIT`), not as safeguarded customer cash.
- `RESELLER_CASH_EARNINGS` — reseller earnings in `PAYOUT_ELIGIBLE`
  mode. Cash payable to a verified third-party legal entity. Moves
  through a pending → available → (reserved) → paid_out lifecycle
  with clawback; never auto-expires.

These books are **distinct** from each other and from
`CASH_WALLET`. Mixing them destroys the legal audit trail and is
explicitly forbidden (see ADR-018 anti-patterns).

New `LedgerEntry.kind` values (additive):

- `RESELLER_EARNINGS_ACCRUAL`, `RESELLER_EARNINGS_MATURATION`,
  `RESELLER_EARNINGS_CLAWBACK`, `RESELLER_EARNINGS_RESERVE_HOLD`,
  `RESELLER_EARNINGS_RESERVE_RELEASE`,
  `RESELLER_EARNINGS_WITHDRAWAL_HOLD`, `RESELLER_EARNINGS_PAID_OUT`,
  `RESELLER_EARNINGS_WITHDRAWAL_REVERSAL`
- `RESELLER_CREDIT_ACCRUAL`, `RESELLER_CREDIT_REDEMPTION`,
  `RESELLER_CREDIT_CLAWBACK`, `RESELLER_CREDIT_EXPIRY`

`PayoutBatch` is extended from the original "Phase 6 tenant-of-tenant
resale payouts" scope to cover reseller earnings withdrawals driven
by `WithdrawalRequest` (see ADR-018). The ledger remains
rail-agnostic; Stripe Connect is the default rail, other bank rails
plug in as adapters.

### Reseller-collections suspense book

When BB collects the guest payment on a reseller-channel booking,
the Stripe `payment_intent.succeeded` webhook posts a `TOPUP` into a
`reseller_collections_suspense` internal book, from which the
double-entry event splits into (a) revenue recognition of
`bb_sell_to_reseller_amount`, (b) platform-fee recognition of
`bb_platform_fee`, and (c) accrual to the reseller's
`RESELLER_PLATFORM_CREDIT` or `RESELLER_CASH_EARNINGS` book. No
silent transfers.

### Refund liability ordering

Refunds and chargebacks against reseller-channel bookings follow a
`RefundLiabilityRule` (ADR-018) that selects the order of recovery
across `RESERVED`, `AVAILABLE`, `PENDING`, and — where contract
permits — `NEGATIVE_AVAILABLE`. Post-payout clawbacks are modelled
explicitly; `NEGATIVE_AVAILABLE` is a first-class state, not an
accounting surprise.

## Amendment 2026-04-21 (see ADR-020) — supplier-side books and VCC

ADR-020 introduces three orthogonal money-movement axes
(`CollectionMode`, `SupplierSettlementMode`, `PaymentCostModel`)
that govern every booking. ADR-012's ledger machinery absorbs them
additively.

### New platform-internal books (not `WalletAccount` types)

Following the pattern of `revenue_suspense` and
`reseller_collections_suspense` — these are platform-internal
double-entry books, not customer-facing wallets:

- `supplier_prepaid_balance_<supplier_id>` — one per supplier we
  hold a topped-up balance with (TBO-style). Top-ups from our bank
  to the supplier post as credits; booking drawdowns post as
  debits. Reconciled against the supplier's statement.
- `supplier_postpaid_payable_<supplier_id>` — payable accrued under
  `POSTPAID_INVOICE` (Hotelbeds merchant). Clears on cycle-invoice
  settlement.
- `supplier_commission_receivable_<supplier_id>` — receivable
  accrued under `COMMISSION_ONLY` per each supplier's recognition
  rule (typically after stay). Clears on commission receipt.
- `vcc_issuance_suspense` — VCC loads recognized at load time;
  clears when the property charges the VCC and settlement lands.

### New `LedgerEntry.kind` values (additive)

```
SUPPLIER_PREPAID_TOPUP          // bank transfer to supplier
SUPPLIER_PREPAID_DRAWDOWN       // booking consumes balance
SUPPLIER_POSTPAID_ACCRUAL       // booking adds to payable
SUPPLIER_POSTPAID_SETTLEMENT    // cycle invoice paid
SUPPLIER_COMMISSION_ACCRUAL     // commission earnable recognized
SUPPLIER_COMMISSION_RECEIVED    // commission actually received
SUPPLIER_COMMISSION_CLAWBACK    // supplier reverses commission
VCC_LOAD                         // virtual card funded
VCC_SETTLEMENT                   // property's charge cleared the VCC
VCC_UNUSED_RETURN                // unused VCC balance returned
```

All existing ADR-012 invariants apply unchanged (append-only,
double-entry, idempotency, currency-explicit).

### `PaymentCostModel` on payment-side entries

Every `LedgerEntry` representing an acquiring cost carries the
resolved `PaymentCostModel` so that margin reports and
reconciliation segment by who bore the fee. For the commission
flow, a single ledger entry may not identify whether an amount is
gross or netted — such ambiguous entries are rejected at write
time.

### No `PaymentIntent` mirror for upstream-collected bookings

Under `CollectionMode = UPSTREAM_PLATFORM_COLLECT`, BB does **not**
create a `PaymentIntent` for the guest's payment to the upstream
platform. Only the commission receivable (and its eventual receipt)
posts to our ledger. Mirroring a payment we never processed is an
explicit ADR-020 anti-pattern.

### Reseller earnings write-gate

`RESELLER_EARNINGS_ACCRUAL` and `RESELLER_CREDIT_ACCRUAL` (ADR-018)
require `CollectionMode = BB_COLLECTS` on the underlying booking.
Posting either on a `PROPERTY_COLLECT` or
`UPSTREAM_PLATFORM_COLLECT` booking is rejected at ledger-write
time — we cannot accrue earnings from money we never collected.

## Open items

- UAE regulatory clarity on stored-value cash wallets — flagged to
  legal before `CASH_WALLET` goes live in production. `PROMO_CREDIT`,
  `LOYALTY_REWARD`, and `REFERRAL_REWARD` are not stored-value cash
  and are lower-risk to launch first. The same concern extends to
  `RESELLER_CASH_EARNINGS` (ADR-018): `PAYOUT_ELIGIBLE` does not
  launch in production for a jurisdiction until legal clearance is
  recorded for that tenant + country combination.
- Invoice generation engine and templating — **resolved**: moved
  to ADR-016. Phase 2 for Beyond Borders direct, Phase 3 for
  reseller-channel.
- Multi-currency wallet unification UX — out of scope; accounts hold
  per-currency wallets with explicit FX only on user action.
- Stripe Connect account model (Standard vs Express vs Custom) —
  Phase 6 when marketplace payouts go live.
