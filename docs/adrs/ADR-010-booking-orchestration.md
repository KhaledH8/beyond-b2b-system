# ADR-010: Booking orchestration

- **Status:** Accepted
- **Date:** 2026-04-21

## Context

A hotel booking spans multiple systems that can each fail independently:
the supplier API (or multiple suppliers for a multi-room/multi-hotel
cart), the payment processor, our own ledger, our email/voucher
service, and sometimes a third-party fraud check. Any one of them can
fail after others have succeeded. Without orchestration, we leak money
(charged-but-not-booked) or inventory (booked-but-not-charged).

## Decision

### Saga-based orchestration

A booking is a **saga**: a sequence of steps, each with a
compensating action. The saga is durable — state is persisted between
steps so a crash or restart does not lose the booking.

### Canonical saga (single-hotel booking)

Steps (happy path):

1. **Validate cart + pricing re-check.** Re-price with current FX and
   current rules. If price changed beyond a tolerance, surface for user
   confirmation.
2. **Quote the supplier rate.** Call `adapter.quoteRate(rateKey)` to
   confirm the rate is still available at the expected net cost. If
   `RateExpired` or `RateChanged`, surface to the user.
3. **Authorize payment.** Authorize but do not capture. (For B2B
   agency/corporate with credit terms, this is a credit check instead.)
4. **Create supplier booking.** `adapter.createBooking(...)`, passing
   our idempotency key. The supplier reservation is now held.
5. **Capture payment.** Capture the prior authorization. (Credit
   flows skip this.)
6. **Persist the `Booking`.** Write our canonical booking row with all
   refs (`canonical_hotel_id`, `supplier_booking_id`, `account_id`,
   pricing trace snapshot).
7. **Ledger entry.** Record the financial entry (revenue, cost,
   markup) — basic MVP ledger, expanded later.
8. **Notify.** Generate voucher, send confirmation email, fire
   webhooks to partner systems if configured.

Each step is idempotent — re-running it with the same idempotency key
is safe.

### Compensating actions (in reverse order)

If step N fails after step N-1 succeeded:

- After step 5 (payment captured), step 4 (supplier booking) failure
  is near-impossible since step 4 precedes step 5. But if the supplier
  booking later reports failed/unknown on reconciliation: refund and
  flag.
- After step 4 (supplier booking made) and step 5 (capture) fails: call
  `adapter.cancelBooking(...)` to release the supplier reservation,
  then void/release the payment authorization.
- After step 3 (auth) and step 4 fails: void the authorization.
- After step 6 (our Booking persisted) and step 7/8 fails: the
  booking is still valid; notify async, retry. Do not unwind.

### State machine

Booking states:
`DRAFT → PRICING_CONFIRMED → RATE_QUOTED → PAYMENT_AUTHORIZED →
SUPPLIER_BOOKED → PAYMENT_CAPTURED → CONFIRMED → NOTIFIED`
plus failure states:
`FAILED_PRICING, FAILED_QUOTE, FAILED_AUTH, FAILED_SUPPLIER,
FAILED_CAPTURE, ROLLBACK_IN_PROGRESS, ROLLBACK_DONE, ROLLBACK_FAILED`

`ROLLBACK_FAILED` is an ops alert, not a silent state.

### Multi-room / multi-hotel carts

Start conservative: MVP supports **single-hotel bookings only**.
Multi-hotel carts are a scope trap — they require either all-or-nothing
orchestration across suppliers or partial-commit semantics, both of
which are complex. Add after the single-hotel spine is rock solid.

### Idempotency

- Every outbound supplier call receives our generated idempotency key
  (per-step, deterministic from booking id + step).
- Every API call into our booking endpoint is idempotent on a
  client-supplied key.

### Durability

- Saga state lives in Postgres (`BookingSaga` table).
- Step execution runs in a BullMQ worker queue with retries and
  exponential backoff. Max retries per step configurable.
- A step's outcome is written before the next step starts.

### Reconciliation

A nightly reconciliation job:
- Compares our `Booking`s in `SUPPLIER_BOOKED`/`CONFIRMED` with
  supplier reports.
- Flags drift (we have it as booked, supplier does not, or vice versa)
  for ops review.
- Flags `ROLLBACK_FAILED` cases for follow-up.

### Temporal revisit

For MVP, BullMQ + explicit saga is enough. If multi-hotel carts,
complex partial refunds, or cross-supplier swaps become real, evaluate
Temporal. The saga table design maps cleanly to Temporal workflows
later.

## Consequences

- No silent money-without-inventory or inventory-without-money states
  in the happy path or failure paths.
- Single-hotel scope protects the MVP; multi-hotel deferred is an
  explicit choice, not an omission.
- Operational monitoring of saga states is required from day one
  (count of FAILED_* and ROLLBACK_FAILED per hour).

## Open items

- Payment provider choice (Stripe is the obvious MVP choice; final
  selection in Phase 2). **Resolved** by ADR-012: Stripe via Stripe
  Connect as the rail.
- Webhook/partner notification shape — Phase 4 when partner API
  surfaces.

## Amendment 2026-04-21 (see ADR-012, ADR-014)

### Tender resolution step (inserted before authorization)

After step 2 (quote) and before step 3 (authorize), a new step runs:

**2.5 Tender resolution.** Resolve the buyer's chosen
`TenderComposition` (ADR-012): wallet cash, promo credit, loyalty,
referral reward, agency credit, corporate credit, card, invoice.
Validate composition against `TenderPolicy` (caps, stacking rules).
Sum must equal `PricedOffer.total`.

Compensations and state implications:

- Wallet-tender legs post `LedgerEntry{status: PENDING}` at step 2.5;
  they commit POSTED on CONFIRMED, or are VOIDED on any rollback.
- Card leg remains a Stripe authorize → capture, wired to step 3
  (authorize) and step 5 (capture) as before.
- Credit-line leg posts `CREDIT_DRAWDOWN{status: PENDING}` at step
  2.5, POSTED on CONFIRMED, VOIDED on rollback. Drawdown exceeding
  credit limit fails the step; booking returns to user for tender
  change.

### Payment step: Stripe is a rail, not the wallet

Step 3 (authorize) and step 5 (capture) call Stripe for the **card**
portion only. Wallet and credit portions do not go through Stripe;
they move on our internal ledger.

Stripe webhooks post follow-on ledger entries asynchronously
(`REFUND`, dispute adjustments), keyed by Stripe event id for
idempotency.

### New terminal step: `REWARDS_ACCRUED`

After `NOTIFIED`:

**9. Rewards accrual.** Resolve loyalty earn rule and referral
qualification (ADR-014). Post `REWARD_ACCRUAL{status: PENDING}`
entries on the relevant wallets. Maturation runs later via the
`maturation-worker`, not inside the saga.

Failure of step 9 does not unwind the booking. The booking is
already valid. Failed accrual enqueues a retry and raises an ops
alert.

### Updated state machine

```
DRAFT
  → PRICING_CONFIRMED
  → RATE_QUOTED
  → TENDER_RESOLVED          // new
  → PAYMENT_AUTHORIZED
  → SUPPLIER_BOOKED
  → PAYMENT_CAPTURED
  → CONFIRMED
  → NOTIFIED
  → REWARDS_ACCRUED          // new; soft-terminal
```

Failure states extended:
`FAILED_TENDER` (invalid composition / credit exhausted),
`FAILED_ACCRUAL` (non-fatal; retriable).

### Multi-hotel remains out of MVP

Unchanged. The tender step adds complexity; it's easier to get right
for single-hotel carts first.
