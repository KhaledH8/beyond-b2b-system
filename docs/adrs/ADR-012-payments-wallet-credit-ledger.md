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

## Open items

- UAE regulatory clarity on stored-value cash wallets — flagged to
  legal before `CASH_WALLET` goes live in production. `PROMO_CREDIT`,
  `LOYALTY_REWARD`, and `REFERRAL_REWARD` are not stored-value cash
  and are lower-risk to launch first.
- Invoice generation engine and templating — Phase 3 (see roadmap).
- Multi-currency wallet unification UX — out of scope; accounts hold
  per-currency wallets with explicit FX only on user action.
- Stripe Connect account model (Standard vs Express vs Custom) —
  Phase 6 when marketplace payouts go live.
