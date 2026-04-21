# Payments and wallet — design note

- **Companion to:** ADR-012 (canonical decisions), ADR-010 (booking
  saga tender step)
- **Audience:** engineers building the ledger, payments, and booking
  modules. Non-normative but elaborative.

## 1. Mental model

Think of the platform as three independent domains that meet at
booking time:

1. **Pricing** (ADR-004) — produces *how much* the booking costs.
2. **Tender** (this doc, ADR-012) — records *how the customer is
   paying*.
3. **Money movement** — Stripe, bank transfers, invoices actually
   moving funds.

Ledger sits between (2) and (3). Every money-movement event produces
a ledger entry; every tender line is backed by a pending ledger entry
that commits on booking confirmation.

## 2. The one rule that keeps this honest

> The ledger is truth. Stripe is a rail.

If Stripe says one thing and the ledger says another, fix the
ledger's ingestion — do not read Stripe for balances. This is not
about distrusting Stripe; it is about domain independence. We can
swap rails without domain code changing.

## 3. Example flows

### 3.1 B2C pays card + promo credit

1. Buyer checks out. Booking total = 500 USD. Buyer composes tender:
   - `WALLET_PROMO`: 50 USD from `PROMO_CREDIT`
   - `CARD_PAYMENT`: 450 USD via Stripe
2. Saga step 2.5 (TENDER_RESOLVED) posts:
   - `LedgerEntry{kind: REWARD_REDEMPTION, status: PENDING, -50 USD}`
     on the buyer's `PROMO_CREDIT` wallet. (Note: promo redemption
     reuses the REWARD_REDEMPTION kind since it is a non-cash credit
     being spent — mental shortcut; the kind name is flexible but
     must be disambiguated in the entry's notes.)
3. Step 3 authorizes 450 USD via Stripe PaymentIntent.
4. Step 4 supplier booking created.
5. Step 5 captures Stripe payment → webhook → `LedgerEntry{kind:
   TOPUP, +450 USD}` and `LedgerEntry{kind: SPEND, -450 USD}` (or
   direct-spend shortcut — one offsetting pair either way).
6. On CONFIRMED, pending entries go POSTED.
7. On any rollback, pending entries VOID and a compensating pair is
   written to preserve auditability.

### 3.2 Agency pays on credit

1. Agency books for 800 USD. Tender:
   - `AGENCY_CREDIT`: 800 USD via agency's credit line.
2. TENDER_RESOLVED posts `LedgerEntry{kind: CREDIT_DRAWDOWN,
   status: PENDING, -800 USD}` on the agency's `AGENCY_CREDIT`
   wallet.
3. Credit line exposure is updated via the derived-view query (not
   by writing a field). If the drawdown would exceed limit, step
   fails; booking returns to tender change.
4. On CONFIRMED, drawdown entry goes POSTED.
5. At end of billing cycle, invoice generator sums POSTED
   drawdowns since last cycle and creates an `Invoice` row. Payment
   clears via bank transfer or Stripe → `LedgerEntry{kind:
   CREDIT_SETTLEMENT, +cycle_total}` posts.

### 3.3 B2C tops up wallet

1. Buyer adds 100 USD to wallet via Stripe Checkout.
2. Stripe `PaymentIntent.succeeded` webhook fires.
3. Webhook handler posts `LedgerEntry{kind: TOPUP, +100 USD}` to
   `CASH_WALLET`. Idempotency key = Stripe event id.
4. Balance view reflects the new total on next read.

## 4. Stripe Connect model — marketplace payouts

Deferred to Phase 6 but designed here so Phase 2 scaffolding is
forward-compatible:

- Platform account (Beyond Borders) is the Stripe platform.
- Each tenant that resells (Phase 6) has a Stripe Connect account
  (Standard or Express; pick during commercial review).
- **Separate charges + transfers** model:
  - Charge buyer on the platform account.
  - After booking and reconciliation, transfer tenant's share to
    the connected account.
  - Each transfer is mirrored by a `PayoutBatch` with its Stripe
    transfer id and a ledger movement from platform holdings to the
    tenant's payable book.
- This keeps financial visibility in the ledger; Stripe transfers
  are ingested events, not the source of truth.

## 5. What could go wrong (and how the ledger catches it)

| Failure | Detection |
|---|---|
| Stripe charges but supplier booking fails | Compensation runs; ledger shows `TOPUP` without matching `SPEND` → reconciliation flags. |
| Ledger posts but Stripe webhook never arrives | Nightly reconciliation queries Stripe `payment_intents` for recent activity and diffs against ledger. |
| Agency exposure exceeds limit through race | Credit limit check is evaluated against current POSTED + PENDING exposure inside a transaction; pending drawdowns compete for limit. |
| Refund posts twice | Stripe event id is the idempotency key; second post is a no-op. |
| Wallet drains to negative through race | Wallet deduction inside a transaction with a guard: `SELECT balance FOR UPDATE` on the wallet account, check balance ≥ amount, then insert entry. Postgres advisory locks or SERIALIZABLE isolation. |

## 6. Operational surface

- Dashboards: per-tenant, per-wallet-type balance totals; daily
  ledger delta; Stripe ingestion lag; credit-line exposure vs limit.
- Alerts: ledger entry rejections, Stripe webhook failures,
  reconciliation drift, `ROLLBACK_FAILED` saga states involving a
  tender leg.

## 7. What we are not doing (yet)

- Multi-currency wallet unification. A user with USD and EUR
  wallets sees two wallets; conversion is explicit user action.
- Automatic cashback: no auto-conversion from `LOYALTY_REWARD` to
  `CASH_WALLET`. Regulatory implications (ADR-012 open item).
- Cash wallet in production before UAE legal review (ADR-012 open
  item).
