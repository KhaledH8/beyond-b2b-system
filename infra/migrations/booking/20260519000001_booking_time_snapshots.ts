import type { Knex } from 'knex';

/**
 * ADR-021 booking-time snapshots (Booking Truth Slice 2).
 *
 * At `CONFIRMED` the booking must pin an **immutable** copy of exactly
 * what was sold, independent of the live supply rows (which have a
 * search-session TTL and can be pruned or superseded). Confirm already
 * pinned the FX lock; this migration adds the offer/price/cancellation
 * truth so a confirmed booking is fully self-describing for refunds,
 * disputes, reconciliation, documents, and rewards.
 *
 * Four additive tables, all written in the existing confirm
 * transaction, all immutable after insert (enforced by a BEFORE
 * UPDATE/DELETE trigger — issued documents/booking truth never mutate;
 * corrections flow through ADR-016 credit/debit notes, not row edits):
 *
 *   booking_sourced_offer_snapshot          1:1 with booking
 *   booking_sourced_price_component_snapshot 0..N (full component copy)
 *   booking_cancellation_policy_snapshot     0..1 (when source had one)
 *   booking_tax_fee_snapshot                 0..N (TAX/FEE components,
 *                                            denormalised per CLAUDE.md
 *                                            §12 named table)
 *
 * `source_*_id` columns carry traceability back to the live
 * `offer_sourced_*` rows but are deliberately **not** foreign keys:
 * booking truth must outlive source pruning. Values are copied, never
 * referenced for reads.
 *
 * This migration is purely additive. No existing table or column is
 * altered; `down()` removes only what `up()` created.
 */
export async function up(knex: Knex): Promise<void> {
  // ── booking_sourced_offer_snapshot ─────────────────────────────────────
  await knex.raw(`
    CREATE TABLE booking_sourced_offer_snapshot (
      id                             CHAR(26)     NOT NULL,
      booking_id                     CHAR(26)     NOT NULL,
      tenant_id                      CHAR(26)     NOT NULL,
      source_offer_snapshot_id       CHAR(26)     NOT NULL,
      supplier_id                    CHAR(26)     NOT NULL,

      supplier_hotel_code            VARCHAR(128) NOT NULL,
      supplier_rate_key              VARCHAR(512) NOT NULL,
      canonical_hotel_id             CHAR(26),

      check_in                       DATE         NOT NULL,
      check_out                      DATE         NOT NULL,
      occupancy_adults               SMALLINT     NOT NULL,
      occupancy_children_ages_jsonb  JSONB        NOT NULL DEFAULT '[]',

      supplier_room_code             VARCHAR(128) NOT NULL,
      canonical_room_type_id         CHAR(26),
      supplier_rate_code             VARCHAR(128) NOT NULL,
      canonical_rate_plan_id         CHAR(26),
      supplier_meal_code             VARCHAR(64),
      canonical_meal_plan_id         CHAR(26),

      total_amount_minor_units       BIGINT       NOT NULL,
      total_currency                 CHAR(3)      NOT NULL,
      rate_breakdown_granularity     VARCHAR(32)  NOT NULL,

      raw_payload_hash               CHAR(64)     NOT NULL,
      raw_payload_storage_ref        VARCHAR(512) NOT NULL,

      source_received_at             TIMESTAMPTZ  NOT NULL,
      source_valid_until             TIMESTAMPTZ  NOT NULL,

      snapshotted_at                 TIMESTAMPTZ  NOT NULL DEFAULT now(),
      created_at                     TIMESTAMPTZ  NOT NULL DEFAULT now(),

      CONSTRAINT booking_sourced_offer_snapshot_pk          PRIMARY KEY (id),
      CONSTRAINT booking_sourced_offer_snapshot_booking_fk  FOREIGN KEY (booking_id)
                                                            REFERENCES booking_booking(id),
      CONSTRAINT booking_sourced_offer_snapshot_tenant_fk   FOREIGN KEY (tenant_id)
                                                            REFERENCES core_tenant(id),
      CONSTRAINT booking_sourced_offer_snapshot_supplier_fk FOREIGN KEY (supplier_id)
                                                            REFERENCES supply_supplier(id),
      CONSTRAINT booking_sourced_offer_snapshot_booking_uq  UNIQUE (booking_id),
      CONSTRAINT booking_sourced_offer_snapshot_dates_chk   CHECK (check_out > check_in),
      CONSTRAINT booking_sourced_offer_snapshot_occ_chk     CHECK (occupancy_adults > 0),
      CONSTRAINT booking_sourced_offer_snapshot_amount_chk  CHECK (total_amount_minor_units >= 0),
      CONSTRAINT booking_sourced_offer_snapshot_gran_chk    CHECK (rate_breakdown_granularity IN (
                                                              'TOTAL_ONLY', 'PER_NIGHT_TOTAL',
                                                              'PER_NIGHT_COMPONENTS',
                                                              'PER_NIGHT_COMPONENTS_TAX'
                                                            ))
    )
  `);
  await knex.raw(`
    CREATE INDEX booking_sourced_offer_snapshot_source_idx
    ON booking_sourced_offer_snapshot(source_offer_snapshot_id)
  `);

  // ── booking_sourced_price_component_snapshot ───────────────────────────
  await knex.raw(`
    CREATE TABLE booking_sourced_price_component_snapshot (
      id                             CHAR(26)     NOT NULL,
      booking_id                     CHAR(26)     NOT NULL,
      booking_sourced_offer_snapshot_id CHAR(26)  NOT NULL,
      source_component_id            CHAR(26)     NOT NULL,
      component_kind                 VARCHAR(32)  NOT NULL,
      description                    VARCHAR(512),
      amount_minor_units             BIGINT       NOT NULL,
      currency                       CHAR(3)      NOT NULL,
      applies_to_night_date          DATE,
      applies_to_person_kind         VARCHAR(32),
      inclusive                      BOOLEAN      NOT NULL DEFAULT FALSE,
      snapshotted_at                 TIMESTAMPTZ  NOT NULL DEFAULT now(),

      CONSTRAINT booking_price_component_snapshot_pk         PRIMARY KEY (id),
      CONSTRAINT booking_price_component_snapshot_booking_fk FOREIGN KEY (booking_id)
                                                             REFERENCES booking_booking(id),
      CONSTRAINT booking_price_component_snapshot_offer_fk   FOREIGN KEY (booking_sourced_offer_snapshot_id)
                                                             REFERENCES booking_sourced_offer_snapshot(id),
      CONSTRAINT booking_price_component_snapshot_kind_chk   CHECK (component_kind IN (
                                                               'ROOM_RATE', 'MEAL_SUPPLEMENT',
                                                               'EXTRA_PERSON_CHARGE', 'TAX',
                                                               'FEE', 'DISCOUNT', 'OTHER'
                                                             )),
      CONSTRAINT booking_price_component_snapshot_person_chk CHECK (applies_to_person_kind IS NULL
                                                               OR applies_to_person_kind IN
                                                                 ('ADULT', 'EXTRA_ADULT', 'CHILD', 'INFANT'))
    )
  `);
  await knex.raw(`
    CREATE INDEX booking_price_component_snapshot_booking_idx
    ON booking_sourced_price_component_snapshot(booking_id)
  `);
  await knex.raw(`
    CREATE INDEX booking_price_component_snapshot_offer_idx
    ON booking_sourced_price_component_snapshot(booking_sourced_offer_snapshot_id)
  `);

  // ── booking_cancellation_policy_snapshot ───────────────────────────────
  await knex.raw(`
    CREATE TABLE booking_cancellation_policy_snapshot (
      id                             CHAR(26)     NOT NULL,
      booking_id                     CHAR(26)     NOT NULL,
      booking_sourced_offer_snapshot_id CHAR(26)  NOT NULL,
      source_cancellation_policy_id  CHAR(26),
      windows_jsonb                  JSONB        NOT NULL DEFAULT '[]',
      refundable                     BOOLEAN      NOT NULL,
      source_verbatim_text           TEXT,
      parsed_with                    VARCHAR(128),
      snapshotted_at                 TIMESTAMPTZ  NOT NULL DEFAULT now(),

      CONSTRAINT booking_cxl_policy_snapshot_pk         PRIMARY KEY (id),
      CONSTRAINT booking_cxl_policy_snapshot_booking_fk FOREIGN KEY (booking_id)
                                                        REFERENCES booking_booking(id),
      CONSTRAINT booking_cxl_policy_snapshot_offer_fk   FOREIGN KEY (booking_sourced_offer_snapshot_id)
                                                        REFERENCES booking_sourced_offer_snapshot(id),
      CONSTRAINT booking_cxl_policy_snapshot_booking_uq UNIQUE (booking_id)
    )
  `);

  // ── booking_tax_fee_snapshot ───────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE booking_tax_fee_snapshot (
      id                             CHAR(26)     NOT NULL,
      booking_id                     CHAR(26)     NOT NULL,
      booking_sourced_offer_snapshot_id CHAR(26)  NOT NULL,
      source_component_id            CHAR(26)     NOT NULL,
      kind                           VARCHAR(8)   NOT NULL,
      description                    VARCHAR(512),
      amount_minor_units             BIGINT       NOT NULL,
      currency                       CHAR(3)      NOT NULL,
      inclusive                      BOOLEAN      NOT NULL DEFAULT FALSE,
      applies_to_night_date          DATE,
      snapshotted_at                 TIMESTAMPTZ  NOT NULL DEFAULT now(),

      CONSTRAINT booking_tax_fee_snapshot_pk         PRIMARY KEY (id),
      CONSTRAINT booking_tax_fee_snapshot_booking_fk FOREIGN KEY (booking_id)
                                                     REFERENCES booking_booking(id),
      CONSTRAINT booking_tax_fee_snapshot_offer_fk   FOREIGN KEY (booking_sourced_offer_snapshot_id)
                                                     REFERENCES booking_sourced_offer_snapshot(id),
      CONSTRAINT booking_tax_fee_snapshot_kind_chk   CHECK (kind IN ('TAX', 'FEE'))
    )
  `);
  await knex.raw(`
    CREATE INDEX booking_tax_fee_snapshot_booking_idx
    ON booking_tax_fee_snapshot(booking_id)
  `);

  // ── Immutability enforcement ───────────────────────────────────────────
  // Booking-time truth is write-once. Any UPDATE/DELETE is a bug or an
  // unauthorised correction path; raise loudly rather than silently
  // mutate audited financial truth.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION booking_snapshot_immutable()
    RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION
        'booking-time snapshot rows are immutable (table %, op %)',
        TG_TABLE_NAME, TG_OP;
    END;
    $$ LANGUAGE plpgsql
  `);
  for (const t of [
    'booking_sourced_offer_snapshot',
    'booking_sourced_price_component_snapshot',
    'booking_cancellation_policy_snapshot',
    'booking_tax_fee_snapshot',
  ]) {
    await knex.raw(`
      CREATE TRIGGER ${t}_immutable
      BEFORE UPDATE OR DELETE ON ${t}
      FOR EACH ROW EXECUTE FUNCTION booking_snapshot_immutable()
    `);
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const t of [
    'booking_sourced_offer_snapshot',
    'booking_sourced_price_component_snapshot',
    'booking_cancellation_policy_snapshot',
    'booking_tax_fee_snapshot',
  ]) {
    await knex.raw(`DROP TRIGGER IF EXISTS ${t}_immutable ON ${t}`);
  }
  await knex.raw('DROP FUNCTION IF EXISTS booking_snapshot_immutable()');
  await knex.raw('DROP TABLE IF EXISTS booking_tax_fee_snapshot');
  await knex.raw('DROP TABLE IF EXISTS booking_cancellation_policy_snapshot');
  await knex.raw(
    'DROP TABLE IF EXISTS booking_sourced_price_component_snapshot',
  );
  await knex.raw('DROP TABLE IF EXISTS booking_sourced_offer_snapshot');
}
