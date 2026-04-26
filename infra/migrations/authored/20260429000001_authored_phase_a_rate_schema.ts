import type { Knex } from 'knex';

/**
 * ADR-022 Phase A: authored direct pricing schema.
 *
 * Creates the six rate_auth_* tables for the AUTHORED_PRIMITIVES
 * evaluator path. Physically separate from offer_sourced_* per
 * ADR-021 § D4 and ADR-022 § D4.
 *
 * Table creation order follows FK dependency (each table may only
 * reference tables already created above it):
 *   1. rate_auth_contract
 *   2. rate_auth_season           → contract
 *   3. rate_auth_child_age_band   → contract
 *   4. rate_auth_base_rate        → contract, season,
 *                                   hotel_room_type, hotel_rate_plan,
 *                                   hotel_occupancy_template, hotel_meal_plan
 *   5. rate_auth_occupancy_supplement → contract, season, room, plan,
 *                                       child_age_band (nullable)
 *   6. rate_auth_meal_supplement  → contract, season, room (nullable),
 *                                   plan (nullable), hotel_meal_plan,
 *                                   child_age_band (nullable)
 *
 * Rollback drops in reverse order.
 *
 * Cross-contract integrity:
 *   rate_auth_season and rate_auth_child_age_band each carry a
 *   UNIQUE(id, contract_id) that makes the (id, contract_id) pair a
 *   valid composite FK target. Every child table that references a
 *   season or an age band does so via a composite FK on
 *   (season_id, contract_id) or (child_age_band_id, contract_id).
 *   Because contract_id is non-null in the child table, the DB
 *   rejects writes that reference a season or band from a different
 *   contract without any application-layer check.
 *   For the nullable child_age_band_id column PostgreSQL uses
 *   MATCH SIMPLE semantics: when child_age_band_id IS NULL the FK is
 *   not checked (correct for EXTRA_ADULT rows); when it is non-null
 *   the full composite is checked (enforces same-contract band).
 *
 * Season non-overlap (ADR-022 § D5) is a business invariant enforced
 * at the application service layer. Only the date-ordering CHECK
 * (date_to >= date_from) is enforced here.
 *
 * Child age bands are contract-scoped per ADR-022 § D6. They are
 * independent of hotel_child_age_band (which serves sourced mapping).
 */
export async function up(knex: Knex): Promise<void> {
  // --- rate_auth_contract ---------------------------------------------------

  await knex.raw(`
    CREATE TABLE rate_auth_contract (
      id                 CHAR(26)     NOT NULL,
      tenant_id          CHAR(26)     NOT NULL,
      canonical_hotel_id CHAR(26)     NOT NULL,
      supplier_id        CHAR(26)     NOT NULL,
      contract_code      VARCHAR(64)  NOT NULL,
      currency           CHAR(3)      NOT NULL,
      valid_from         DATE,
      valid_to           DATE,
      status             VARCHAR(16)  NOT NULL DEFAULT 'DRAFT',
      version            SMALLINT     NOT NULL DEFAULT 1,
      parent_contract_id CHAR(26),
      signed_doc_ref     VARCHAR(512),
      notes              TEXT,
      created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
      updated_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),

      CONSTRAINT rate_auth_contract_pk           PRIMARY KEY (id),
      CONSTRAINT rate_auth_contract_tenant_fk    FOREIGN KEY (tenant_id)
                                                 REFERENCES core_tenant(id),
      CONSTRAINT rate_auth_contract_hotel_fk     FOREIGN KEY (canonical_hotel_id)
                                                 REFERENCES hotel_canonical(id),
      CONSTRAINT rate_auth_contract_supplier_fk  FOREIGN KEY (supplier_id)
                                                 REFERENCES supply_supplier(id),
      CONSTRAINT rate_auth_contract_parent_fk    FOREIGN KEY (parent_contract_id)
                                                 REFERENCES rate_auth_contract(id),
      CONSTRAINT rate_auth_contract_code_uq      UNIQUE (tenant_id, contract_code),
      CONSTRAINT rate_auth_contract_status_chk   CHECK (status IN ('DRAFT', 'ACTIVE', 'INACTIVE')),
      CONSTRAINT rate_auth_contract_version_chk  CHECK (version >= 1),
      CONSTRAINT rate_auth_contract_window_chk   CHECK (
        valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from
      )
    )
  `);

  // Active-contract lookup by hotel during search fan-out.
  await knex.raw(`
    CREATE INDEX rate_auth_contract_hotel_idx
    ON rate_auth_contract(tenant_id, canonical_hotel_id)
  `);

  // Admin listing by status; partial covers the search-path hot case.
  await knex.raw(`
    CREATE INDEX rate_auth_contract_active_idx
    ON rate_auth_contract(tenant_id, canonical_hotel_id)
    WHERE status = 'ACTIVE'
  `);

  // --- rate_auth_season -----------------------------------------------------
  //
  // UNIQUE(id, contract_id) exists solely as a composite FK target so
  // that child tables can declare (season_id, contract_id) FKs and let
  // the DB enforce same-contract membership. The PK already covers
  // uniqueness on id alone; this constraint adds contract_id to the key.

  await knex.raw(`
    CREATE TABLE rate_auth_season (
      id           CHAR(26)     NOT NULL,
      contract_id  CHAR(26)     NOT NULL,
      name         VARCHAR(128) NOT NULL,
      date_from    DATE         NOT NULL,
      date_to      DATE         NOT NULL,
      created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
      updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),

      CONSTRAINT rate_auth_season_pk              PRIMARY KEY (id),
      CONSTRAINT rate_auth_season_contract_fk     FOREIGN KEY (contract_id)
                                                  REFERENCES rate_auth_contract(id),
      CONSTRAINT rate_auth_season_id_contract_uq  UNIQUE (id, contract_id),
      CONSTRAINT rate_auth_season_dates_chk       CHECK (date_to >= date_from)
    )
  `);

  // Season resolution per contract (lookup + overlap-check read).
  await knex.raw(`
    CREATE INDEX rate_auth_season_contract_idx
    ON rate_auth_season(contract_id, date_from, date_to)
  `);

  // --- rate_auth_child_age_band ---------------------------------------------
  //
  // Same composite-unique pattern as rate_auth_season: UNIQUE(id, contract_id)
  // allows supplement tables to reference (child_age_band_id, contract_id)
  // and get same-contract enforcement from the DB for non-null band rows.

  await knex.raw(`
    CREATE TABLE rate_auth_child_age_band (
      id           CHAR(26)    NOT NULL,
      contract_id  CHAR(26)    NOT NULL,
      name         VARCHAR(64) NOT NULL,
      age_min      SMALLINT    NOT NULL,
      age_max      SMALLINT    NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

      CONSTRAINT rate_auth_child_age_band_pk             PRIMARY KEY (id),
      CONSTRAINT rate_auth_child_age_band_contract_fk    FOREIGN KEY (contract_id)
                                                         REFERENCES rate_auth_contract(id),
      CONSTRAINT rate_auth_child_age_band_id_contract_uq UNIQUE (id, contract_id),
      CONSTRAINT rate_auth_child_age_band_range_chk      CHECK (age_max >= age_min),
      CONSTRAINT rate_auth_child_age_band_ages_chk       CHECK (age_min >= 0 AND age_max <= 17)
    )
  `);

  await knex.raw(`
    CREATE INDEX rate_auth_child_age_band_contract_idx
    ON rate_auth_child_age_band(contract_id)
  `);

  // --- rate_auth_base_rate --------------------------------------------------
  //
  // Season FK is composite (season_id, contract_id) → rate_auth_season(id,
  // contract_id). Because contract_id is non-null in this table the DB
  // rejects any base rate whose season belongs to a different contract.

  await knex.raw(`
    CREATE TABLE rate_auth_base_rate (
      id                    CHAR(26)    NOT NULL,
      contract_id           CHAR(26)    NOT NULL,
      season_id             CHAR(26)    NOT NULL,
      room_type_id          CHAR(26)    NOT NULL,
      rate_plan_id          CHAR(26)    NOT NULL,
      occupancy_template_id CHAR(26)    NOT NULL,
      included_meal_plan_id CHAR(26)    NOT NULL,
      amount_minor_units    BIGINT      NOT NULL,
      currency              CHAR(3)     NOT NULL,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

      CONSTRAINT rate_auth_base_rate_pk           PRIMARY KEY (id),
      CONSTRAINT rate_auth_base_rate_contract_fk  FOREIGN KEY (contract_id)
                                                  REFERENCES rate_auth_contract(id),
      CONSTRAINT rate_auth_base_rate_season_fk    FOREIGN KEY (season_id, contract_id)
                                                  REFERENCES rate_auth_season(id, contract_id),
      CONSTRAINT rate_auth_base_rate_room_fk      FOREIGN KEY (room_type_id)
                                                  REFERENCES hotel_room_type(id),
      CONSTRAINT rate_auth_base_rate_plan_fk      FOREIGN KEY (rate_plan_id)
                                                  REFERENCES hotel_rate_plan(id),
      CONSTRAINT rate_auth_base_rate_occupancy_fk FOREIGN KEY (occupancy_template_id)
                                                  REFERENCES hotel_occupancy_template(id),
      CONSTRAINT rate_auth_base_rate_meal_fk      FOREIGN KEY (included_meal_plan_id)
                                                  REFERENCES hotel_meal_plan(id),
      CONSTRAINT rate_auth_base_rate_combo_uq     UNIQUE (
                                                    contract_id, season_id,
                                                    room_type_id, rate_plan_id,
                                                    occupancy_template_id
                                                  ),
      CONSTRAINT rate_auth_base_rate_amount_chk   CHECK (amount_minor_units >= 0)
    )
  `);

  // Composition lookup: season already known, narrow by room + plan.
  await knex.raw(`
    CREATE INDEX rate_auth_base_rate_lookup_idx
    ON rate_auth_base_rate(contract_id, season_id, room_type_id, rate_plan_id)
  `);

  // --- rate_auth_occupancy_supplement ---------------------------------------
  //
  // Season FK: composite (season_id, contract_id) → same-contract enforcement.
  // Band FK:   composite (child_age_band_id, contract_id) → same-contract
  //            enforcement. PostgreSQL MATCH SIMPLE: when child_age_band_id
  //            IS NULL (EXTRA_ADULT rows) the FK is not checked, which is
  //            correct. When non-null (EXTRA_CHILD rows) both columns are
  //            checked against rate_auth_child_age_band(id, contract_id).

  await knex.raw(`
    CREATE TABLE rate_auth_occupancy_supplement (
      id                 CHAR(26)    NOT NULL,
      contract_id        CHAR(26)    NOT NULL,
      season_id          CHAR(26)    NOT NULL,
      room_type_id       CHAR(26)    NOT NULL,
      rate_plan_id       CHAR(26)    NOT NULL,
      occupant_kind      VARCHAR(16) NOT NULL,
      child_age_band_id  CHAR(26),
      slot_index         SMALLINT    NOT NULL DEFAULT 1,
      amount_minor_units BIGINT      NOT NULL,
      pricing_basis      VARCHAR(32) NOT NULL DEFAULT 'PER_NIGHT_PER_PERSON',
      created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

      CONSTRAINT rate_auth_occupancy_supplement_pk          PRIMARY KEY (id),
      CONSTRAINT rate_auth_occupancy_supplement_contract_fk FOREIGN KEY (contract_id)
                                                            REFERENCES rate_auth_contract(id),
      CONSTRAINT rate_auth_occupancy_supplement_season_fk   FOREIGN KEY (season_id, contract_id)
                                                            REFERENCES rate_auth_season(id, contract_id),
      CONSTRAINT rate_auth_occupancy_supplement_room_fk     FOREIGN KEY (room_type_id)
                                                            REFERENCES hotel_room_type(id),
      CONSTRAINT rate_auth_occupancy_supplement_plan_fk     FOREIGN KEY (rate_plan_id)
                                                            REFERENCES hotel_rate_plan(id),
      CONSTRAINT rate_auth_occupancy_supplement_band_fk     FOREIGN KEY (child_age_band_id, contract_id)
                                                            REFERENCES rate_auth_child_age_band(id, contract_id),
      CONSTRAINT rate_auth_occupancy_supplement_kind_chk    CHECK (occupant_kind IN
                                                              ('EXTRA_ADULT', 'EXTRA_CHILD')),
      CONSTRAINT rate_auth_occupancy_supplement_slot_chk    CHECK (slot_index >= 1),
      CONSTRAINT rate_auth_occupancy_supplement_amount_chk  CHECK (amount_minor_units >= 0),
      CONSTRAINT rate_auth_occupancy_supplement_basis_chk   CHECK (pricing_basis IN
                                                              ('PER_NIGHT_PER_PERSON'))
    )
  `);

  // Uniqueness for EXTRA_ADULT rows: child_age_band_id must be null.
  await knex.raw(`
    CREATE UNIQUE INDEX rate_auth_occupancy_supplement_adult_uq
    ON rate_auth_occupancy_supplement(
      contract_id, season_id, room_type_id, rate_plan_id, occupant_kind, slot_index
    )
    WHERE child_age_band_id IS NULL
  `);

  // Uniqueness for EXTRA_CHILD rows: child_age_band_id must be non-null.
  await knex.raw(`
    CREATE UNIQUE INDEX rate_auth_occupancy_supplement_child_uq
    ON rate_auth_occupancy_supplement(
      contract_id, season_id, room_type_id, rate_plan_id,
      occupant_kind, child_age_band_id, slot_index
    )
    WHERE child_age_band_id IS NOT NULL
  `);

  // Composition lookup: fetch all supplements for a (contract, season, room, plan).
  await knex.raw(`
    CREATE INDEX rate_auth_occupancy_supplement_lookup_idx
    ON rate_auth_occupancy_supplement(contract_id, season_id, room_type_id, rate_plan_id)
  `);

  // --- rate_auth_meal_supplement --------------------------------------------
  //
  // room_type_id and rate_plan_id are nullable: null means the supplement
  // applies to all rooms or all plans within the contract respectively.
  // child_age_band_id is nullable: null means applies to all children
  // (or is irrelevant for occupant_kind = 'ADULT').
  //
  // Season FK: composite (season_id, contract_id) → same-contract enforcement.
  // Band FK:   composite (child_age_band_id, contract_id) → same-contract
  //            enforcement via MATCH SIMPLE (null child_age_band_id bypasses
  //            the check; non-null enforces full composite lookup).
  //
  // Uniqueness across nullable FK combinations is enforced at the
  // application service layer, not in the DB, to keep the index surface
  // tractable.

  await knex.raw(`
    CREATE TABLE rate_auth_meal_supplement (
      id                  CHAR(26)    NOT NULL,
      contract_id         CHAR(26)    NOT NULL,
      season_id           CHAR(26)    NOT NULL,
      room_type_id        CHAR(26),
      rate_plan_id        CHAR(26),
      target_meal_plan_id CHAR(26)    NOT NULL,
      occupant_kind       VARCHAR(16) NOT NULL,
      child_age_band_id   CHAR(26),
      amount_minor_units  BIGINT      NOT NULL,
      pricing_basis       VARCHAR(32) NOT NULL DEFAULT 'PER_NIGHT_PER_PERSON',
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

      CONSTRAINT rate_auth_meal_supplement_pk             PRIMARY KEY (id),
      CONSTRAINT rate_auth_meal_supplement_contract_fk    FOREIGN KEY (contract_id)
                                                          REFERENCES rate_auth_contract(id),
      CONSTRAINT rate_auth_meal_supplement_season_fk      FOREIGN KEY (season_id, contract_id)
                                                          REFERENCES rate_auth_season(id, contract_id),
      CONSTRAINT rate_auth_meal_supplement_room_fk        FOREIGN KEY (room_type_id)
                                                          REFERENCES hotel_room_type(id),
      CONSTRAINT rate_auth_meal_supplement_plan_fk        FOREIGN KEY (rate_plan_id)
                                                          REFERENCES hotel_rate_plan(id),
      CONSTRAINT rate_auth_meal_supplement_target_meal_fk FOREIGN KEY (target_meal_plan_id)
                                                          REFERENCES hotel_meal_plan(id),
      CONSTRAINT rate_auth_meal_supplement_band_fk        FOREIGN KEY (child_age_band_id, contract_id)
                                                          REFERENCES rate_auth_child_age_band(id, contract_id),
      CONSTRAINT rate_auth_meal_supplement_kind_chk       CHECK (occupant_kind IN ('ADULT', 'CHILD')),
      CONSTRAINT rate_auth_meal_supplement_amount_chk     CHECK (amount_minor_units >= 0),
      CONSTRAINT rate_auth_meal_supplement_basis_chk      CHECK (pricing_basis IN
                                                            ('PER_NIGHT_PER_PERSON'))
    )
  `);

  // Composition lookup: fetch all meal supplements for a (contract, season).
  // Room and plan filtering happens in application code after this index scan.
  await knex.raw(`
    CREATE INDEX rate_auth_meal_supplement_lookup_idx
    ON rate_auth_meal_supplement(contract_id, season_id)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP TABLE IF EXISTS rate_auth_meal_supplement');
  await knex.raw('DROP TABLE IF EXISTS rate_auth_occupancy_supplement');
  await knex.raw('DROP TABLE IF EXISTS rate_auth_base_rate');
  await knex.raw('DROP TABLE IF EXISTS rate_auth_child_age_band');
  await knex.raw('DROP TABLE IF EXISTS rate_auth_season');
  await knex.raw('DROP TABLE IF EXISTS rate_auth_contract');
}
