import type { Knex } from 'knex';

/**
 * Booking Truth Slice 3 — supplier-booking columns on `booking_booking`.
 *
 * The supplier-book step records a (fixture-only, this slice)
 * supplier reservation as **data**, without changing
 * `booking_booking.status` — proper saga sequencing
 * (`SUPPLIER_BOOKED` state) is deferred to the full ADR-010 saga.
 * Reuses the shell's existing `supplier_id` (FK) and
 * `supplier_confirmation_ref` columns; adds three NULLable columns
 * for the booking timestamp, the supplier-side status, and the mode
 * (FIXTURE today; LIVE is a later, deliberate slice).
 *
 * Purely additive. No existing column/constraint is altered;
 * `down()` removes only what `up()` created.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE booking_booking
      ADD COLUMN supplier_booked_at      TIMESTAMPTZ,
      ADD COLUMN supplier_booking_status VARCHAR(16),
      ADD COLUMN supplier_booking_mode   VARCHAR(16)
  `);

  await knex.raw(`
    ALTER TABLE booking_booking
      ADD CONSTRAINT booking_booking_supplier_bk_status_chk
        CHECK (supplier_booking_status IS NULL
               OR supplier_booking_status IN ('CONFIRMED', 'ON_REQUEST'))
  `);

  await knex.raw(`
    ALTER TABLE booking_booking
      ADD CONSTRAINT booking_booking_supplier_bk_mode_chk
        CHECK (supplier_booking_mode IS NULL
               OR supplier_booking_mode IN ('FIXTURE', 'LIVE'))
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE booking_booking
      DROP CONSTRAINT IF EXISTS booking_booking_supplier_bk_mode_chk
  `);
  await knex.raw(`
    ALTER TABLE booking_booking
      DROP CONSTRAINT IF EXISTS booking_booking_supplier_bk_status_chk
  `);
  await knex.raw(`
    ALTER TABLE booking_booking
      DROP COLUMN IF EXISTS supplier_booking_mode,
      DROP COLUMN IF EXISTS supplier_booking_status,
      DROP COLUMN IF EXISTS supplier_booked_at
  `);
}
