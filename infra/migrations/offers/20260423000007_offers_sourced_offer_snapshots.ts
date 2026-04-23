import type { Knex } from 'knex';

/**
 * ADR-021 sourced offer snapshots — the supply-side landing zone for
 * composed offers returned by bedbank / OTA / affiliate APIs at search
 * time. TTL-driven (`valid_until`); snapshots referenced by a confirmed
 * booking are copied into `booking_sourced_offer_snapshot` at CONFIRMED
 * in Phase 2 and from that point live independently of the live row.
 *
 * Shape contract (ADR-021):
 *   - rate_breakdown_granularity ∈ {TOTAL_ONLY, PER_NIGHT_TOTAL,
 *     PER_NIGHT_COMPONENTS, PER_NIGHT_COMPONENTS_TAX,
 *     AUTHORED_PRIMITIVES}. Only the first four are valid on a sourced
 *     snapshot; AUTHORED_PRIMITIVES belongs to the authored path.
 *   - offer_sourced_component rows populated only to the extent the
 *     supplier exposed a breakdown. TOTAL_ONLY leaves the child table
 *     empty.
 *   - offer_sourced_cancellation_policy is 1:1 with the snapshot.
 *
 * Raw payloads live in object storage (ADR-003); we persist only the
 * content hash and storage ref.
 */
export async function up(knex: Knex): Promise<void> {
  // --- offer_sourced_snapshot --------------------------------------------

  await knex.raw(`
    CREATE TABLE offer_sourced_snapshot (
      id                             CHAR(26)     NOT NULL,
      tenant_id                      CHAR(26)     NOT NULL,
      supplier_id                    CHAR(26)     NOT NULL,
      canonical_hotel_id             CHAR(26),
      supplier_hotel_code            VARCHAR(128) NOT NULL,
      supplier_rate_key              VARCHAR(512) NOT NULL,
      search_session_id              CHAR(26)     NOT NULL,

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

      received_at                    TIMESTAMPTZ  NOT NULL DEFAULT now(),
      valid_until                    TIMESTAMPTZ  NOT NULL,

      raw_payload_hash               CHAR(64)     NOT NULL,
      raw_payload_storage_ref        VARCHAR(512) NOT NULL,

      superseded_by_id               CHAR(26),
      status                         VARCHAR(32)  NOT NULL DEFAULT 'ACTIVE',

      created_at                     TIMESTAMPTZ  NOT NULL DEFAULT now(),

      CONSTRAINT offer_sourced_snapshot_pk              PRIMARY KEY (id),
      CONSTRAINT offer_sourced_snapshot_tenant_fk       FOREIGN KEY (tenant_id)
                                                        REFERENCES core_tenant(id),
      CONSTRAINT offer_sourced_snapshot_supplier_fk     FOREIGN KEY (supplier_id)
                                                        REFERENCES supply_supplier(id),
      CONSTRAINT offer_sourced_snapshot_hotel_fk        FOREIGN KEY (canonical_hotel_id)
                                                        REFERENCES hotel_canonical(id),
      CONSTRAINT offer_sourced_snapshot_room_fk         FOREIGN KEY (canonical_room_type_id)
                                                        REFERENCES hotel_room_type(id),
      CONSTRAINT offer_sourced_snapshot_rate_plan_fk    FOREIGN KEY (canonical_rate_plan_id)
                                                        REFERENCES hotel_rate_plan(id),
      CONSTRAINT offer_sourced_snapshot_meal_fk         FOREIGN KEY (canonical_meal_plan_id)
                                                        REFERENCES hotel_meal_plan(id),
      CONSTRAINT offer_sourced_snapshot_superseded_fk   FOREIGN KEY (superseded_by_id)
                                                        REFERENCES offer_sourced_snapshot(id),
      CONSTRAINT offer_sourced_snapshot_dates_chk       CHECK (check_out > check_in),
      CONSTRAINT offer_sourced_snapshot_occupancy_chk   CHECK (occupancy_adults > 0),
      CONSTRAINT offer_sourced_snapshot_amount_chk      CHECK (total_amount_minor_units >= 0),
      CONSTRAINT offer_sourced_snapshot_granularity_chk CHECK (rate_breakdown_granularity IN (
                                                          'TOTAL_ONLY', 'PER_NIGHT_TOTAL',
                                                          'PER_NIGHT_COMPONENTS',
                                                          'PER_NIGHT_COMPONENTS_TAX'
                                                        )),
      CONSTRAINT offer_sourced_snapshot_status_chk      CHECK (status IN
                                                          ('ACTIVE', 'EXPIRED', 'SUPERSEDED', 'BOOKED'))
    )
  `);

  // Search-session lookup: common read path is "all snapshots for this search."
  await knex.raw(`
    CREATE INDEX offer_sourced_snapshot_session_idx
    ON offer_sourced_snapshot(tenant_id, search_session_id)
  `);

  // Hot path for TTL sweeper.
  await knex.raw(`
    CREATE INDEX offer_sourced_snapshot_valid_until_idx
    ON offer_sourced_snapshot(valid_until)
    WHERE status = 'ACTIVE'
  `);

  await knex.raw(`
    CREATE INDEX offer_sourced_snapshot_hotel_idx
    ON offer_sourced_snapshot(canonical_hotel_id)
    WHERE canonical_hotel_id IS NOT NULL
  `);

  await knex.raw(`
    CREATE INDEX offer_sourced_snapshot_supplier_key_idx
    ON offer_sourced_snapshot(supplier_id, supplier_rate_key)
  `);

  // --- offer_sourced_component -------------------------------------------

  await knex.raw(`
    CREATE TABLE offer_sourced_component (
      id                       CHAR(26)     NOT NULL,
      offer_snapshot_id        CHAR(26)     NOT NULL,
      component_kind           VARCHAR(32)  NOT NULL,
      description              VARCHAR(512),
      amount_minor_units       BIGINT       NOT NULL,
      currency                 CHAR(3)      NOT NULL,
      applies_to_night_date    DATE,
      applies_to_person_kind   VARCHAR(32),
      inclusive                BOOLEAN      NOT NULL DEFAULT FALSE,
      created_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),

      CONSTRAINT offer_sourced_component_pk            PRIMARY KEY (id),
      CONSTRAINT offer_sourced_component_snapshot_fk   FOREIGN KEY (offer_snapshot_id)
                                                       REFERENCES offer_sourced_snapshot(id)
                                                       ON DELETE CASCADE,
      CONSTRAINT offer_sourced_component_kind_chk      CHECK (component_kind IN (
                                                         'ROOM_RATE', 'MEAL_SUPPLEMENT',
                                                         'EXTRA_PERSON_CHARGE', 'TAX',
                                                         'FEE', 'DISCOUNT', 'OTHER'
                                                       )),
      CONSTRAINT offer_sourced_component_person_chk    CHECK (applies_to_person_kind IS NULL
                                                         OR applies_to_person_kind IN
                                                           ('ADULT', 'EXTRA_ADULT', 'CHILD', 'INFANT'))
    )
  `);

  await knex.raw(`
    CREATE INDEX offer_sourced_component_snapshot_idx
    ON offer_sourced_component(offer_snapshot_id)
  `);

  // --- offer_sourced_restriction -----------------------------------------

  await knex.raw(`
    CREATE TABLE offer_sourced_restriction (
      id                    CHAR(26)     NOT NULL,
      offer_snapshot_id     CHAR(26)     NOT NULL,
      restriction_kind      VARCHAR(32)  NOT NULL,
      params                JSONB        NOT NULL DEFAULT '{}',
      source_verbatim_text  TEXT,
      created_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),

      CONSTRAINT offer_sourced_restriction_pk            PRIMARY KEY (id),
      CONSTRAINT offer_sourced_restriction_snapshot_fk   FOREIGN KEY (offer_snapshot_id)
                                                         REFERENCES offer_sourced_snapshot(id)
                                                         ON DELETE CASCADE,
      CONSTRAINT offer_sourced_restriction_kind_chk      CHECK (restriction_kind IN (
                                                           'STOP_SELL', 'CTA', 'CTD',
                                                           'MIN_LOS', 'MAX_LOS',
                                                           'ADVANCE_PURCHASE_MIN',
                                                           'ADVANCE_PURCHASE_MAX',
                                                           'RELEASE_HOURS', 'CUTOFF_HOURS'
                                                         ))
    )
  `);

  await knex.raw(`
    CREATE INDEX offer_sourced_restriction_snapshot_idx
    ON offer_sourced_restriction(offer_snapshot_id)
  `);

  // --- offer_sourced_cancellation_policy ---------------------------------

  // 1:1 with the snapshot. `parsed_with` records parser id+version so
  // historical snapshots can be re-parsed after parser improvements
  // without mutating the original.
  await knex.raw(`
    CREATE TABLE offer_sourced_cancellation_policy (
      id                    CHAR(26)     NOT NULL,
      offer_snapshot_id     CHAR(26)     NOT NULL,
      windows_jsonb         JSONB        NOT NULL DEFAULT '[]',
      refundable            BOOLEAN      NOT NULL,
      source_verbatim_text  TEXT,
      parsed_with           VARCHAR(128),
      created_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),

      CONSTRAINT offer_sourced_cancellation_policy_pk             PRIMARY KEY (id),
      CONSTRAINT offer_sourced_cancellation_policy_snapshot_fk    FOREIGN KEY (offer_snapshot_id)
                                                                  REFERENCES offer_sourced_snapshot(id)
                                                                  ON DELETE CASCADE,
      CONSTRAINT offer_sourced_cancellation_policy_snapshot_uq    UNIQUE (offer_snapshot_id)
    )
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP TABLE IF EXISTS offer_sourced_cancellation_policy');
  await knex.raw('DROP TABLE IF EXISTS offer_sourced_restriction');
  await knex.raw('DROP TABLE IF EXISTS offer_sourced_component');
  await knex.raw('DROP TABLE IF EXISTS offer_sourced_snapshot');
}
