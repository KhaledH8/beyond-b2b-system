import type { Knex } from 'knex';

/**
 * Booking intake (Slice 1) — additive columns on `booking_booking`.
 *
 * The booking shell (20260422000004) only modelled the confirmed-fact
 * surface needed by the FX-lock confirm path. Booking *intake* — the
 * creation of an INITIATED row from a selected priced sourced offer —
 * needs four more facts persisted at creation time. All four are
 * NULLable so this migration is purely additive: every existing
 * (already-CONFIRMED) row keeps NULLs and its behaviour is unchanged.
 *
 *   source_offer_snapshot_id  Link back to the `offer_sourced_snapshot`
 *                             the booking was created from. Deliberately
 *                             NOT a foreign key: a booking must outlive
 *                             offer-snapshot pruning (snapshots have a
 *                             search-session lifecycle; bookings are
 *                             permanent). Reconciliation joins on it
 *                             best-effort.
 *   idempotency_key           Client-supplied key. A partial UNIQUE
 *                             index over (tenant_id, idempotency_key)
 *                             makes intake replay-safe: a repeated
 *                             POST returns the same booking instead of
 *                             creating a duplicate.
 *   supplier_ref              Supplier identifier/code selected at
 *                             intake (e.g. 'HOTELBEDS'). Distinct from
 *                             the FK `supplier_id`, which stays NULL
 *                             until a real supplier booking is made in
 *                             a later slice (schema comment on the
 *                             shell already reserves supplier_id for
 *                             "post-supplier confirmation").
 *   supplier_raw_ref          Opaque supplier rate reference preserved
 *                             for a future idempotent `adapter.book()`
 *                             call. No money moves in this slice.
 *
 * ADR-021 booking-time snapshot pinning at CONFIRMED is explicitly NOT
 * done here — `source_offer_snapshot_id` is a soft link for intake/
 * reconciliation only, not the immutable booking-time snapshot.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE booking_booking
      ADD COLUMN source_offer_snapshot_id CHAR(26),
      ADD COLUMN idempotency_key          VARCHAR(255),
      ADD COLUMN supplier_ref             VARCHAR(64),
      ADD COLUMN supplier_raw_ref         VARCHAR(128)
  `);

  await knex.raw(`
    CREATE UNIQUE INDEX booking_booking_idem_uq
    ON booking_booking(tenant_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL
  `);

  await knex.raw(`
    CREATE INDEX booking_booking_source_offer_idx
    ON booking_booking(source_offer_snapshot_id)
    WHERE source_offer_snapshot_id IS NOT NULL
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(
    'DROP INDEX IF EXISTS booking_booking_source_offer_idx',
  );
  await knex.raw('DROP INDEX IF EXISTS booking_booking_idem_uq');
  await knex.raw(`
    ALTER TABLE booking_booking
      DROP COLUMN IF EXISTS supplier_raw_ref,
      DROP COLUMN IF EXISTS supplier_ref,
      DROP COLUMN IF EXISTS idempotency_key,
      DROP COLUMN IF EXISTS source_offer_snapshot_id
  `);
}
