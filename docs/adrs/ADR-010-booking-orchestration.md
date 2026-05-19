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

## Amendment 2026-04-22 (see ADR-016, ADR-017)

### Document issue is not inside the saga

Step 8 ("Notify") previously bundled voucher generation and email
into a single saga step. That is now split:

- The saga's step 8 emits a `BookingConfirmed` domain event and
  terminates as `NOTIFIED`. The saga is done with documents at
  this point.
- A separate `document-issue-worker` consumes `BookingConfirmed`
  and materializes the `BookingDocument` rows appropriate to the
  booking's `DocumentIssuePolicy` (ADR-016) — including
  `TAX_INVOICE`, `BB_BOOKING_CONFIRMATION`, `BB_VOUCHER` (for
  direct BB bookings) or `TAX_INVOICE` +
  `RESELLER_GUEST_CONFIRMATION` + `RESELLER_GUEST_VOUCHER` (for
  reseller-channel bookings per ADR-017).
- A separate `document-delivery-worker` consumes `DocumentIssued`
  events and fires delivery channels (email, portal, webhook)
  with their own retries.

Rationale: a broken email provider or a PDF render failure must
never compensate a successful booking. ADR-016 makes this the
architectural default.

### Cancellation and amendment emit document events

Cancellations post `REWARD_CLAWBACK` and other ledger corrections
as before, and additionally emit a `BookingCancelled` or
`BookingAmended` event. The document-issue-worker materializes a
`CREDIT_NOTE` (for downward corrections or cancellations) or
`DEBIT_NOTE` (for upward corrections) against the original
`TAX_INVOICE`, and a superseding `RESELLER_GUEST_*` confirmation
if applicable.

### State machine unchanged

`NOTIFIED` remains the terminal-before-rewards state. Document
state lives on `BookingDocument`, not on the saga.

## Amendment 2026-04-21 (see ADR-020) — saga branches on CollectionMode

The saga becomes conditional on the rate's `CollectionMode` from
ADR-020. All branches share the same state-machine skeleton; steps
are skipped or added based on mode. The triple
(`CollectionMode`, `SupplierSettlementMode`, `PaymentCostModel`) is
persisted on the `Booking` row at confirmation time and is
immutable thereafter.

### Mode-conditional steps

- **`BB_COLLECTS`** — full saga as amended above. No change.
- **`RESELLER_COLLECTS`** — step 2.5 (tender resolution) and step 3
  / 5 (auth / capture) are billed against the reseller per ADR-017
  (`BillingProfile` + `CreditLine`) or ADR-018
  (`reseller_collections_suspense`). No guest-facing
  `PaymentIntent`.
- **`PROPERTY_COLLECT`** — step 2.5 runs with an empty tender
  composition (we collect no money). Steps 3 (authorize) and 5
  (capture) are **skipped**. The saga progresses
  `TENDER_RESOLVED` → `SUPPLIER_BOOKED` → `CONFIRMED` → `NOTIFIED`.
- **`UPSTREAM_PLATFORM_COLLECT`** — as `PROPERTY_COLLECT` on our
  side. Additionally, the `CONFIRMED` transition waits on an
  upstream-platform confirmation webhook before firing.

### New step (4.5): `VCC_ISSUED`

When `SupplierSettlementMode = VCC_TO_PROPERTY`, after step 4
(create supplier booking) and before step 5 (capture), issue a
virtual card for the supplier net amount in the supplier's
required currency, bind it to the supplier booking, and post a
`VCC_LOAD` ledger entry (ADR-012 amendment 2026-04-21). Compensation
on later failure: cancel / refund the VCC load.

Failure state added: `FAILED_VCC_LOAD` — retryable with backoff,
fatal after policy threshold → rollback prior steps.

### Extended state machine (additive)

```
DRAFT
  → PRICING_CONFIRMED
  → RATE_QUOTED
  → TENDER_RESOLVED          // empty composition for PROPERTY_COLLECT
                             //   and UPSTREAM_PLATFORM_COLLECT
  → PAYMENT_AUTHORIZED       // skipped when no guest payment
  → SUPPLIER_BOOKED
  → VCC_ISSUED               // only when VCC_TO_PROPERTY
  → PAYMENT_CAPTURED         // skipped when no guest payment
  → CONFIRMED                // for UPSTREAM_PLATFORM_COLLECT, waits on
                             //   upstream webhook
  → NOTIFIED
  → REWARDS_ACCRUED
```

### Document archetype ties back to mode

The document-issue-worker (ADR-016 + the 2026-04-22 amendment above)
consumes `BookingConfirmed` and materializes document sets per the
`DocumentIssuePolicy` **and** per the booking's `CollectionMode`.
Key change from ADR-020: `PROPERTY_COLLECT` and
`UPSTREAM_PLATFORM_COLLECT` bookings do **not** receive a BB
`TAX_INVOICE` to the guest; a `COMMISSION_INVOICE` is issued to
the supplier / upstream platform after commission recognition.
See ADR-020 §Document impact.

### Anti-patterns

- **Creating a `PaymentIntent` on a `PROPERTY_COLLECT` or
  `UPSTREAM_PLATFORM_COLLECT` booking.** No guest money moves
  through our rail.
- **Populating `TenderComposition.lines` on a `PROPERTY_COLLECT`
  booking.** Tender composition is empty.
- **Firing `CONFIRMED` on an `UPSTREAM_PLATFORM_COLLECT` booking
  without the upstream webhook handshake.** We have not confirmed
  guest payment.

## Amendment 2026-05-19 (Booking Intake — Slice 1)

### Intake creates `INITIATED`, not the full ADR-010 saga state set

The canonical saga state machine in this ADR
(`DRAFT → PRICING_CONFIRMED → RATE_QUOTED → …`) is the **target**
shape. It is **not** yet implemented. The implemented
`booking_booking` shell persists a deliberately smaller status set
(`INITIATED, PENDING_PAYMENT, CONFIRMED, CANCELLED, FAILED,
REFUNDED`). Booking Intake (Slice 1) creates a row in `INITIATED` —
the shell's entry state — directly from a selected priced **sourced**
offer. This is an intentional, documented divergence: the durable
saga, `RATE_QUOTED`/`PAYMENT_AUTHORIZED`/`SUPPLIER_BOOKED` steps, and
the compensating actions are deferred to later slices. No supplier
`book()`, payment, ledger, or document work happens at intake.

### Audit at intake

A `BOOKING_CREATED` (`APP`) audit event is written via
`AuditService.emitInTransaction` in the **same transaction** as the
`booking_booking` insert. An un-audited booking is never committed —
this is stricter than the ADR-028 default for `APP` (which permits
best-effort background emission) and is a deliberate booking-truth
choice.

### Soft offer link, not the ADR-021 booking-time snapshot

`booking_booking.source_offer_snapshot_id` (added in the intake
migration, NULLable, no FK) is an intake/reconciliation convenience
only. It is **not** the ADR-021 immutable booking-time snapshot.
ADR-021 snapshot pinning at `CONFIRMED` (sourced/authored +
cancellation-policy + tax/fee, in the confirmation transaction)
remains the next booking-truth slice and is unaffected by this link.

### Anti-patterns (intake)

- **Treating `source_offer_snapshot_id` as the booking-time
  snapshot.** It is a soft link; the offer snapshot has a
  search-session lifecycle and may be pruned. Historical booking
  truth must come from the ADR-021 snapshots, not this column.
- **Calling a supplier `book()` from intake.** Intake never moves
  money or holds supplier inventory.
- **Skipping the `PROVISIONAL` bookability gate.** A rate whose
  money-movement triple is unresolved must never become a booking
  (ADR-020).

## Amendment 2026-05-19 (Booking Truth — Slice 2)

### Confirm pins ADR-021 booking-time truth in the same transaction

`BookingService.confirm` now performs ADR-021 booking-time snapshot
pinning inside the **existing** confirm transaction, alongside the
status flip and the FX lock. In one all-or-nothing unit it: re-reads
the live `offer_sourced_*` rows for the booking's
`source_offer_snapshot_id`, copies them into four immutable tables
(`booking_sourced_offer_snapshot` 1:1,
`booking_sourced_price_component_snapshot`,
`booking_cancellation_policy_snapshot`,
`booking_tax_fee_snapshot`), and emits a durable `BOOKING_CONFIRMED`
audit event via `AuditService.emitInTransaction`. Any failure (missing
source snapshot, snapshot insert, or audit) rolls the whole confirm
back — a booking never reaches CONFIRMED without complete, audited
booking-time truth. This supersedes the Slice 1 note that snapshot
pinning was "the next slice."

### Deliberate divergences from a literal ADR-021 reading

- **Tax/fee is a denormalised view, not a separate source.** The
  sourced supply model has no dedicated tax/fee table; TAX and FEE are
  `offer_sourced_component` rows. `booking_tax_fee_snapshot` (named in
  CLAUDE.md §12) is populated by copying the TAX/FEE component subset,
  in addition to the full component copy. It is a convenience view for
  reconciliation/documents, not a second source of truth.
- **Authored path not exercised.** Only the `SOURCED_COMPOSED` path is
  pinned. `booking_authored_rate_snapshot` is intentionally not
  created until an authored supply source is confirmed end-to-end.
- **`source_offer_snapshot_id` is a soft trace key.** No FK from
  booking-time tables to `offer_sourced_*`: booking truth must outlive
  source pruning. Values are copied; the id is for tracing only.

### Anti-patterns (snapshot pinning)

- **Reading the live `offer_sourced_*` row for a confirmed booking.**
  Use the pinned booking-time rows; the live row may be expired,
  superseded, or re-parsed.
- **Mutating a booking-time snapshot.** The immutability trigger
  raises; corrections flow through ADR-016 credit/debit notes.
- **Confirming a booking with no live source snapshot.** Refused
  (409) and rolled back — never confirm with un-pinnable truth.

## Amendment 2026-05-19 (Booking Truth — Slice 3: supplier booking, fixture mode)

### Supplier-book is an independent, data-only step (not in confirm)

A new `POST /internal/bookings/:id/supplier-book` performs a
fixture-only supplier reservation and records it on `booking_booking`
(`supplier_id`, `supplier_confirmation_ref`, `supplier_booked_at`,
`supplier_booking_status`, `supplier_booking_mode`). It is **not**
folded into the confirm transaction and does **not** change
`booking_booking.status`. Rationale: `adapter.book()` is outbound IO
(HTTP under live) and must never sit inside a DB transaction; ADR-010
models supplier booking as its own idempotent step with its own
compensation. The contract `adapter.book()` runs **before** a short
DB transaction that writes the columns and emits `BOOKING_SUPPLIER_
BOOKED` via `emitInTransaction` (audit failure rolls the write back).

### Deliberate deferrals (documented divergence, consistent with Slices 1–2)

- **No `SUPPLIER_BOOKED` status / saga sequencing.** The shell status
  set is unchanged; supplier-book neither gates nor reorders confirm.
  True ADR-010 ordering (`SUPPLIER_BOOKED` before `CONFIRMED`, with
  compensation) is a later, dedicated saga slice.
- **Fixture-only.** Only the Hotelbeds fixture client implements
  `book()` (deterministic `HB-FIX-<sha256-12>` ref). Stub and live
  clients reject `book()` with `NOT_IMPLEMENTED`; the step surfaces
  that as HTTP 501. Live supplier booking is impossible until its own
  certification slice.
- **No `cancel()` / compensation.** `cancel()` still throws
  `NOT_IMPLEMENTED`; cancellation-refund compensation is out of scope.
- **No payment, ledger, documents.**

### Idempotency

`supplier_confirmation_ref IS NOT NULL` is the idempotency lever:
a replayed supplier-book returns the existing details with
`replayed: true`, performs no adapter call, and emits no second
audit. The `recordSupplierBooking` UPDATE additionally guards
`supplier_confirmation_ref IS NULL` + non-terminal status so a
concurrent winner cannot be overwritten.

### Anti-patterns (supplier-book)

- **Calling `adapter.book()` inside a DB transaction.** It is
  outbound IO; keep it before `BEGIN`.
- **Treating supplier-book as a status transition.** It is data;
  status sequencing belongs to the saga slice.
- **Allowing a live/stub adapter to "succeed".** Only fixture mode
  may produce a ref this slice; everything else is 501.
