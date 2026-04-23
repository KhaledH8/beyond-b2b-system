import type { Knex } from 'knex';

/**
 * ADR-021 mapping surface from supplier codes to canonical product
 * dimensions. Mirrors the ADR-008 HotelMapping convention:
 *   - mapping_method ∈ {DETERMINISTIC, FUZZY, MANUAL}
 *   - status ∈ {PENDING, CONFIRMED, REJECTED, SUPERSEDED}
 *   - superseded_by_id chains historical decisions
 *   - partial unique idx excluding REJECTED|SUPERSEDED enforces
 *     one active mapping per (supplier, supplier code) tuple
 *
 * Canonical targets are nullable — a mapping may be PENDING awaiting
 * canonical creation, or REJECTED without a target.
 */
export async function up(knex: Knex): Promise<void> {
  // --- hotel_room_mapping -------------------------------------------------

  await knex.raw(`
    CREATE TABLE hotel_room_mapping (
      id                      CHAR(26)     NOT NULL,
      supplier_id             CHAR(26)     NOT NULL,
      supplier_hotel_id       CHAR(26)     NOT NULL,
      supplier_room_code      VARCHAR(128) NOT NULL,
      canonical_room_type_id  CHAR(26),
      mapping_method          VARCHAR(32)  NOT NULL DEFAULT 'DETERMINISTIC',
      confidence              NUMERIC(5,4),
      status                  VARCHAR(32)  NOT NULL DEFAULT 'PENDING',
      raw_signals             JSONB        NOT NULL DEFAULT '{}',
      superseded_by_id        CHAR(26),
      created_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
      updated_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),

      CONSTRAINT hotel_room_mapping_pk              PRIMARY KEY (id),
      CONSTRAINT hotel_room_mapping_supplier_fk     FOREIGN KEY (supplier_id)
                                                    REFERENCES supply_supplier(id),
      CONSTRAINT hotel_room_mapping_hotel_fk        FOREIGN KEY (supplier_hotel_id)
                                                    REFERENCES hotel_supplier(id),
      CONSTRAINT hotel_room_mapping_room_fk         FOREIGN KEY (canonical_room_type_id)
                                                    REFERENCES hotel_room_type(id),
      CONSTRAINT hotel_room_mapping_superseded_fk   FOREIGN KEY (superseded_by_id)
                                                    REFERENCES hotel_room_mapping(id),
      CONSTRAINT hotel_room_mapping_confidence_chk  CHECK (confidence BETWEEN 0.0 AND 1.0),
      CONSTRAINT hotel_room_mapping_method_chk      CHECK (mapping_method IN
                                                      ('DETERMINISTIC', 'FUZZY', 'MANUAL')),
      CONSTRAINT hotel_room_mapping_status_chk      CHECK (status IN
                                                      ('PENDING', 'CONFIRMED', 'REJECTED', 'SUPERSEDED'))
    )
  `);

  await knex.raw(`
    CREATE UNIQUE INDEX hotel_room_mapping_active_uq
    ON hotel_room_mapping(supplier_id, supplier_hotel_id, supplier_room_code)
    WHERE status NOT IN ('REJECTED', 'SUPERSEDED')
  `);

  await knex.raw(`
    CREATE INDEX hotel_room_mapping_room_idx
    ON hotel_room_mapping(canonical_room_type_id)
    WHERE canonical_room_type_id IS NOT NULL
  `);

  // --- hotel_rate_plan_mapping --------------------------------------------

  await knex.raw(`
    CREATE TABLE hotel_rate_plan_mapping (
      id                      CHAR(26)     NOT NULL,
      supplier_id             CHAR(26)     NOT NULL,
      supplier_hotel_id       CHAR(26)     NOT NULL,
      supplier_rate_code      VARCHAR(128) NOT NULL,
      canonical_rate_plan_id  CHAR(26),
      rate_class_override     VARCHAR(32),
      mapping_method          VARCHAR(32)  NOT NULL DEFAULT 'DETERMINISTIC',
      confidence              NUMERIC(5,4),
      status                  VARCHAR(32)  NOT NULL DEFAULT 'PENDING',
      raw_signals             JSONB        NOT NULL DEFAULT '{}',
      superseded_by_id        CHAR(26),
      created_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
      updated_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),

      CONSTRAINT hotel_rate_plan_mapping_pk               PRIMARY KEY (id),
      CONSTRAINT hotel_rate_plan_mapping_supplier_fk      FOREIGN KEY (supplier_id)
                                                          REFERENCES supply_supplier(id),
      CONSTRAINT hotel_rate_plan_mapping_hotel_fk         FOREIGN KEY (supplier_hotel_id)
                                                          REFERENCES hotel_supplier(id),
      CONSTRAINT hotel_rate_plan_mapping_plan_fk          FOREIGN KEY (canonical_rate_plan_id)
                                                          REFERENCES hotel_rate_plan(id),
      CONSTRAINT hotel_rate_plan_mapping_superseded_fk    FOREIGN KEY (superseded_by_id)
                                                          REFERENCES hotel_rate_plan_mapping(id),
      CONSTRAINT hotel_rate_plan_mapping_confidence_chk   CHECK (confidence BETWEEN 0.0 AND 1.0),
      CONSTRAINT hotel_rate_plan_mapping_method_chk       CHECK (mapping_method IN
                                                            ('DETERMINISTIC', 'FUZZY', 'MANUAL')),
      CONSTRAINT hotel_rate_plan_mapping_status_chk       CHECK (status IN
                                                            ('PENDING', 'CONFIRMED', 'REJECTED', 'SUPERSEDED')),
      CONSTRAINT hotel_rate_plan_mapping_class_chk        CHECK (rate_class_override IS NULL OR rate_class_override IN (
                                                            'PUBLIC_BAR', 'ADVANCE_PURCHASE',
                                                            'NON_REFUNDABLE', 'MEMBER',
                                                            'CORPORATE', 'NEGOTIATED',
                                                            'OPAQUE_WHOLESALE'
                                                          ))
    )
  `);

  await knex.raw(`
    CREATE UNIQUE INDEX hotel_rate_plan_mapping_active_uq
    ON hotel_rate_plan_mapping(supplier_id, supplier_hotel_id, supplier_rate_code)
    WHERE status NOT IN ('REJECTED', 'SUPERSEDED')
  `);

  await knex.raw(`
    CREATE INDEX hotel_rate_plan_mapping_plan_idx
    ON hotel_rate_plan_mapping(canonical_rate_plan_id)
    WHERE canonical_rate_plan_id IS NOT NULL
  `);

  // --- hotel_meal_plan_mapping --------------------------------------------

  // Supplier-global rather than hotel-scoped — meal plan vocabularies
  // are shared across a supplier's portfolio.
  await knex.raw(`
    CREATE TABLE hotel_meal_plan_mapping (
      id                      CHAR(26)     NOT NULL,
      supplier_id             CHAR(26)     NOT NULL,
      supplier_meal_code      VARCHAR(64)  NOT NULL,
      canonical_meal_plan_id  CHAR(26),
      mapping_method          VARCHAR(32)  NOT NULL DEFAULT 'DETERMINISTIC',
      confidence              NUMERIC(5,4),
      status                  VARCHAR(32)  NOT NULL DEFAULT 'PENDING',
      raw_signals             JSONB        NOT NULL DEFAULT '{}',
      superseded_by_id        CHAR(26),
      created_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
      updated_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),

      CONSTRAINT hotel_meal_plan_mapping_pk              PRIMARY KEY (id),
      CONSTRAINT hotel_meal_plan_mapping_supplier_fk     FOREIGN KEY (supplier_id)
                                                         REFERENCES supply_supplier(id),
      CONSTRAINT hotel_meal_plan_mapping_plan_fk         FOREIGN KEY (canonical_meal_plan_id)
                                                         REFERENCES hotel_meal_plan(id),
      CONSTRAINT hotel_meal_plan_mapping_superseded_fk   FOREIGN KEY (superseded_by_id)
                                                         REFERENCES hotel_meal_plan_mapping(id),
      CONSTRAINT hotel_meal_plan_mapping_confidence_chk  CHECK (confidence BETWEEN 0.0 AND 1.0),
      CONSTRAINT hotel_meal_plan_mapping_method_chk      CHECK (mapping_method IN
                                                           ('DETERMINISTIC', 'FUZZY', 'MANUAL')),
      CONSTRAINT hotel_meal_plan_mapping_status_chk      CHECK (status IN
                                                           ('PENDING', 'CONFIRMED', 'REJECTED', 'SUPERSEDED'))
    )
  `);

  await knex.raw(`
    CREATE UNIQUE INDEX hotel_meal_plan_mapping_active_uq
    ON hotel_meal_plan_mapping(supplier_id, supplier_meal_code)
    WHERE status NOT IN ('REJECTED', 'SUPERSEDED')
  `);

  // --- hotel_occupancy_mapping --------------------------------------------

  await knex.raw(`
    CREATE TABLE hotel_occupancy_mapping (
      id                              CHAR(26)     NOT NULL,
      supplier_id                     CHAR(26)     NOT NULL,
      supplier_hotel_id               CHAR(26)     NOT NULL,
      supplier_occupancy_code         VARCHAR(128),
      canonical_occupancy_template_id CHAR(26),
      mapping_method                  VARCHAR(32)  NOT NULL DEFAULT 'DETERMINISTIC',
      confidence                      NUMERIC(5,4),
      status                          VARCHAR(32)  NOT NULL DEFAULT 'PENDING',
      raw_signals                     JSONB        NOT NULL DEFAULT '{}',
      created_at                      TIMESTAMPTZ  NOT NULL DEFAULT now(),
      updated_at                      TIMESTAMPTZ  NOT NULL DEFAULT now(),

      CONSTRAINT hotel_occupancy_mapping_pk              PRIMARY KEY (id),
      CONSTRAINT hotel_occupancy_mapping_supplier_fk     FOREIGN KEY (supplier_id)
                                                         REFERENCES supply_supplier(id),
      CONSTRAINT hotel_occupancy_mapping_hotel_fk        FOREIGN KEY (supplier_hotel_id)
                                                         REFERENCES hotel_supplier(id),
      CONSTRAINT hotel_occupancy_mapping_template_fk     FOREIGN KEY (canonical_occupancy_template_id)
                                                         REFERENCES hotel_occupancy_template(id),
      CONSTRAINT hotel_occupancy_mapping_confidence_chk  CHECK (confidence BETWEEN 0.0 AND 1.0),
      CONSTRAINT hotel_occupancy_mapping_method_chk      CHECK (mapping_method IN
                                                           ('DETERMINISTIC', 'FUZZY', 'MANUAL')),
      CONSTRAINT hotel_occupancy_mapping_status_chk      CHECK (status IN
                                                           ('PENDING', 'CONFIRMED', 'REJECTED', 'SUPERSEDED'))
    )
  `);

  // Expression-based partial unique: treat NULL occupancy_code as the
  // implicit supplier-default template, so each (supplier, hotel) has
  // at most one active "default" plus one per distinct coded variant.
  await knex.raw(`
    CREATE UNIQUE INDEX hotel_occupancy_mapping_active_uq
    ON hotel_occupancy_mapping(supplier_id, supplier_hotel_id, COALESCE(supplier_occupancy_code, ''))
    WHERE status NOT IN ('REJECTED', 'SUPERSEDED')
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP TABLE IF EXISTS hotel_occupancy_mapping');
  await knex.raw('DROP TABLE IF EXISTS hotel_meal_plan_mapping');
  await knex.raw('DROP TABLE IF EXISTS hotel_rate_plan_mapping');
  await knex.raw('DROP TABLE IF EXISTS hotel_room_mapping');
}
