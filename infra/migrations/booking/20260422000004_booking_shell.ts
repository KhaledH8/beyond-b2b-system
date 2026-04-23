import type { Knex } from 'knex';

/**
 * Booking shell — stores the confirmed facts needed for every downstream
 * concern (refunds, disputes, reconciliation, rewards, documents).
 *
 * ADR-020: the three money-movement axes (collection_mode,
 * supplier_settlement_mode, payment_cost_model) are written once at
 * confirmation and are immutable for the lifetime of the booking.
 *
 * Phase 2 adds: booking_leg, booking_saga, booking_tender.
 * Phase 2 also adds the ledger linkage (tender_composition).
 * Guest PII in guest_details is JSONB; column-level encryption is Phase 2.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE booking_booking (
      id                       CHAR(26)     NOT NULL,
      tenant_id                CHAR(26)     NOT NULL,
      account_id               CHAR(26)     NOT NULL,
      canonical_hotel_id       CHAR(26)     NOT NULL,

      -- ADR-020 money-movement triple; immutable once status = CONFIRMED
      collection_mode          VARCHAR(32)  NOT NULL,
      supplier_settlement_mode VARCHAR(32)  NOT NULL,
      payment_cost_model       VARCHAR(32)  NOT NULL,

      -- stay dates (property-local dates; timezone stored in guest_details)
      check_in                 DATE         NOT NULL,
      check_out                DATE         NOT NULL,

      -- human-readable reference, unique per tenant (e.g. BB-2026-XXXXX)
      reference                VARCHAR(64)  NOT NULL,

      status                   VARCHAR(32)  NOT NULL DEFAULT 'INITIATED',

      -- PII: guest details; column-level encryption added in Phase 2
      guest_details            JSONB        NOT NULL DEFAULT '{}',

      -- populated post-supplier confirmation
      supplier_id              CHAR(26),
      supplier_confirmation_ref VARCHAR(128),

      -- pricing snapshot at time of booking (not a ledger fact)
      sell_amount_minor_units  BIGINT,
      sell_currency            CHAR(3),

      created_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),
      updated_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),

      CONSTRAINT booking_booking_pk              PRIMARY KEY (id),
      CONSTRAINT booking_booking_tenant_fk       FOREIGN KEY (tenant_id)
                                                 REFERENCES core_tenant(id),
      CONSTRAINT booking_booking_account_fk      FOREIGN KEY (account_id)
                                                 REFERENCES core_account(id),
      CONSTRAINT booking_booking_hotel_fk        FOREIGN KEY (canonical_hotel_id)
                                                 REFERENCES hotel_canonical(id),
      CONSTRAINT booking_booking_supplier_fk     FOREIGN KEY (supplier_id)
                                                 REFERENCES supply_supplier(id),
      CONSTRAINT booking_booking_dates_chk       CHECK (check_out > check_in),
      CONSTRAINT booking_booking_status_chk      CHECK (status IN (
                                                   'INITIATED', 'PENDING_PAYMENT',
                                                   'CONFIRMED', 'CANCELLED', 'FAILED', 'REFUNDED'
                                                 )),
      CONSTRAINT booking_booking_collection_chk  CHECK (collection_mode IN (
                                                   'BB_COLLECTS', 'RESELLER_COLLECTS',
                                                   'PROPERTY_COLLECT', 'UPSTREAM_PLATFORM_COLLECT'
                                                 )),
      CONSTRAINT booking_booking_settlement_chk  CHECK (supplier_settlement_mode IN (
                                                   'PREPAID_BALANCE', 'POSTPAID_INVOICE',
                                                   'COMMISSION_ONLY', 'VCC_TO_PROPERTY',
                                                   'DIRECT_PROPERTY_CHARGE'
                                                 )),
      CONSTRAINT booking_booking_cost_model_chk  CHECK (payment_cost_model IN (
                                                   'PLATFORM_CARD_FEE', 'RESELLER_CARD_FEE',
                                                   'PROPERTY_CARD_FEE', 'UPSTREAM_NETTED',
                                                   'BANK_TRANSFER_SETTLEMENT'
                                                 ))
    )
  `);

  await knex.raw(`
    CREATE UNIQUE INDEX booking_booking_ref_uq
    ON booking_booking(tenant_id, reference)
  `);

  await knex.raw(`
    CREATE INDEX booking_booking_account_idx
    ON booking_booking(account_id)
  `);

  await knex.raw(`
    CREATE INDEX booking_booking_hotel_idx
    ON booking_booking(canonical_hotel_id)
  `);

  await knex.raw(`
    CREATE INDEX booking_booking_status_idx
    ON booking_booking(status)
  `);

  await knex.raw(`
    CREATE INDEX booking_booking_created_idx
    ON booking_booking(tenant_id, created_at DESC)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP TABLE IF EXISTS booking_booking');
}
