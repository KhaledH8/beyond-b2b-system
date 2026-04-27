import type { Knex } from 'knex';

/**
 * ADR-024 C5a: booking-time FX lock — schema only.
 *
 * One table, additive. No service code, no Nest changes, no booking-saga
 * changes. Confirmation-time integration (the transaction that pins this
 * row alongside the ADR-021 booking snapshots) is C5c and arrives in a
 * later migration / code change. C5b (Stripe FX Quote client) and C5d
 * (refund integration) are also separate slices.
 *
 * Purpose:
 *
 *   `booking_fx_lock` records, for one booking, the FX rate at which a
 *   confirmation, refund, or cancellation fee was committed to the
 *   customer's charge currency. It is **separate from search-time
 *   display FX** (`fx_application` written by C4): that audit table
 *   logs presentation-only conversions, while this table records
 *   contractual rates the customer's card sees.
 *
 *   Source-currency truth is unchanged. The ledger continues to record
 *   amounts in source currency (ADR-024 D6); this row is the parallel
 *   record of what the payment-execution path used to charge the card.
 *
 * Locked design corrections from the C5 plan review:
 *
 *   1. ECB is NOT a booking-time FX lock provider. The CHECK constraint
 *      restricts `provider` to ('STRIPE', 'OXR'). ECB remains a
 *      search-time / reference-only fallback (its daily-publish cadence
 *      is incompatible with a card-charge contract). If Stripe is
 *      unavailable AND no acceptable OXR snapshot exists, the saga
 *      confirms the booking in source currency and writes NO row in
 *      this table.
 *
 *   2. Refund and cancellation rates derive from the original
 *      CONFIRMATION row, never from a fresh spot rate. C5d will append
 *      `applied_kind = 'REFUND'` / `'CANCELLATION_FEE'` rows that copy
 *      the confirmation lock's rate forward — this schema permits but
 *      does not enforce that wiring (the enforcement lives in the
 *      service layer, not in a SQL constraint).
 *
 * Lock-kind / provider / id-column / expiry coherence:
 *
 *   lock_kind             provider   provider_quote_id   rate_snapshot_id   expires_at
 *   --------------------  ---------  ------------------  -----------------  ----------
 *   'STRIPE_FX_QUOTE'     'STRIPE'   NOT NULL            NULL               NOT NULL
 *   'SNAPSHOT_REFERENCE'  'OXR'      NULL                NOT NULL           NULL
 *
 *   The `booking_fx_lock_kind_coherence_chk` constraint is the single
 *   source of truth for the table above. Adding a third lock kind
 *   (e.g. another exchange's quote API) requires editing this CHECK
 *   deliberately — silent drift is impossible.
 *
 * Idempotency:
 *
 *   The partial unique index `booking_fx_lock_confirmation_uq` allows
 *   exactly one `applied_kind = 'CONFIRMATION'` row per booking. Saga
 *   retries that re-issue the confirmation transaction will fail this
 *   constraint on the second attempt, signalling "already confirmed."
 *   `REFUND` and `CANCELLATION_FEE` rows are unconstrained — a booking
 *   may have multiple over its lifetime.
 *
 * Retention:
 *
 *   No pruning. Unlike `fx_application`'s SEARCH-kind rows (eligible
 *   for retention pruning per ADR-024 D7), `booking_fx_lock` rows are
 *   retained for the full booking lifetime so refunds and disputes
 *   that happen years later can resolve back to the original lock.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE booking_fx_lock (
      id                  CHAR(26)      NOT NULL,
      booking_id          CHAR(26)      NOT NULL,

      applied_kind        VARCHAR(16)   NOT NULL,
      lock_kind           VARCHAR(32)   NOT NULL,

      source_currency     CHAR(3)       NOT NULL,
      charge_currency     CHAR(3)       NOT NULL,

      -- 1 source = N charge. The customer's card-currency amount is
      -- materialised in charge_minor; rate is kept for audit so the
      -- relationship is reconstructible if charge_minor ever needs to
      -- be re-derived.
      rate                NUMERIC(18,8) NOT NULL,
      source_minor        BIGINT        NOT NULL,
      charge_minor        BIGINT        NOT NULL,

      provider            VARCHAR(16)   NOT NULL,

      -- Populated for STRIPE_FX_QUOTE, NULL for SNAPSHOT_REFERENCE.
      -- The Stripe API quote id (or future provider-equivalent) is the
      -- handle a PaymentIntent uses to lock the conversion at charge.
      provider_quote_id   VARCHAR(64),

      -- Populated for SNAPSHOT_REFERENCE, NULL for STRIPE_FX_QUOTE.
      -- Always traces to a row in fx_rate_snapshot.
      rate_snapshot_id    CHAR(26),

      -- Stripe quote TTL (typically ~1 minute). NULL for
      -- SNAPSHOT_REFERENCE rows since OXR observations have no
      -- contractual expiry semantics on this platform.
      expires_at          TIMESTAMPTZ,

      applied_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),

      CONSTRAINT booking_fx_lock_pk
        PRIMARY KEY (id),

      CONSTRAINT booking_fx_lock_booking_fk
        FOREIGN KEY (booking_id)
        REFERENCES booking_booking(id),

      CONSTRAINT booking_fx_lock_snapshot_fk
        FOREIGN KEY (rate_snapshot_id)
        REFERENCES fx_rate_snapshot(id),

      CONSTRAINT booking_fx_lock_applied_chk
        CHECK (applied_kind IN ('CONFIRMATION', 'REFUND', 'CANCELLATION_FEE')),

      CONSTRAINT booking_fx_lock_lock_chk
        CHECK (lock_kind IN ('STRIPE_FX_QUOTE', 'SNAPSHOT_REFERENCE')),

      -- ECB is intentionally absent from this enum. ECB remains a
      -- search-time reference fallback only (ADR-024 + C5 plan locked
      -- correction #1). Adding ECB here would require an ADR amendment.
      CONSTRAINT booking_fx_lock_provider_chk
        CHECK (provider IN ('STRIPE', 'OXR')),

      CONSTRAINT booking_fx_lock_rate_chk
        CHECK (rate > 0),

      CONSTRAINT booking_fx_lock_source_minor_chk
        CHECK (source_minor >= 0),

      CONSTRAINT booking_fx_lock_charge_minor_chk
        CHECK (charge_minor >= 0),

      -- A lock only exists when the source and charge currencies
      -- differ; same-currency bookings skip this row entirely.
      CONSTRAINT booking_fx_lock_currency_chk
        CHECK (source_currency <> charge_currency),

      -- The single CHECK that ties (lock_kind, provider,
      -- provider_quote_id, rate_snapshot_id) into one coherent shape.
      CONSTRAINT booking_fx_lock_kind_coherence_chk
        CHECK (
          (lock_kind = 'STRIPE_FX_QUOTE'
            AND provider = 'STRIPE'
            AND provider_quote_id IS NOT NULL
            AND rate_snapshot_id IS NULL
            AND expires_at IS NOT NULL)
          OR
          (lock_kind = 'SNAPSHOT_REFERENCE'
            AND provider = 'OXR'
            AND provider_quote_id IS NULL
            AND rate_snapshot_id IS NOT NULL
            AND expires_at IS NULL)
        )
    )
  `);

  // Per-booking history scan, newest first. Refund and cancellation
  // flows query "the most recent CONFIRMATION row for this booking";
  // audit / reconciliation queries scan the full per-booking history.
  await knex.raw(`
    CREATE INDEX booking_fx_lock_booking_idx
    ON booking_fx_lock (booking_id, applied_at DESC)
  `);

  // Idempotency for the confirmation transaction. A second
  // applied_kind = 'CONFIRMATION' insert for the same booking fails
  // this constraint, which the saga interprets as "already
  // confirmed." REFUND and CANCELLATION_FEE rows are unconstrained
  // (a booking may accrue many over its lifetime).
  await knex.raw(`
    CREATE UNIQUE INDEX booking_fx_lock_confirmation_uq
    ON booking_fx_lock (booking_id)
    WHERE applied_kind = 'CONFIRMATION'
  `);
}

export async function down(knex: Knex): Promise<void> {
  // Indexes drop automatically with the table; explicit DROP for the
  // table is enough.
  await knex.raw('DROP TABLE IF EXISTS booking_fx_lock');
}
