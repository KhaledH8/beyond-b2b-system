import type { Knex } from 'knex';

/**
 * ADR-021 canonical product dimensions — platform-wide catalog
 * entities per canonical hotel. No tenant_id: these are facts about
 * the real hotel, not per-tenant preferences. Per-tenant visibility
 * and selling rules live elsewhere (pricing rules scope, merchandising).
 *
 * hotel_meal_plan allows canonical_hotel_id NULL for the small set of
 * globally shared meal plans (RO, BB, HB, FB, AI); per-hotel overrides
 * carry canonical_hotel_id.
 */
export async function up(knex: Knex): Promise<void> {
  // --- hotel_room_type ---------------------------------------------------

  await knex.raw(`
    CREATE TABLE hotel_room_type (
      id                  CHAR(26)     NOT NULL,
      canonical_hotel_id  CHAR(26)     NOT NULL,
      code                VARCHAR(64)  NOT NULL,
      name                VARCHAR(255) NOT NULL,
      description         TEXT,
      max_occupancy_hint  SMALLINT,
      status              VARCHAR(32)  NOT NULL DEFAULT 'ACTIVE',
      created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
      updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),

      CONSTRAINT hotel_room_type_pk          PRIMARY KEY (id),
      CONSTRAINT hotel_room_type_hotel_fk    FOREIGN KEY (canonical_hotel_id)
                                             REFERENCES hotel_canonical(id),
      CONSTRAINT hotel_room_type_code_uq     UNIQUE (canonical_hotel_id, code),
      CONSTRAINT hotel_room_type_status_chk  CHECK (status IN ('ACTIVE', 'INACTIVE'))
    )
  `);

  // --- hotel_meal_plan ---------------------------------------------------

  await knex.raw(`
    CREATE TABLE hotel_meal_plan (
      id                  CHAR(26)     NOT NULL,
      canonical_hotel_id  CHAR(26),
      code                VARCHAR(32)  NOT NULL,
      name                VARCHAR(255) NOT NULL,
      includes            JSONB        NOT NULL DEFAULT '[]',
      status              VARCHAR(32)  NOT NULL DEFAULT 'ACTIVE',
      created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
      updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),

      CONSTRAINT hotel_meal_plan_pk          PRIMARY KEY (id),
      CONSTRAINT hotel_meal_plan_hotel_fk    FOREIGN KEY (canonical_hotel_id)
                                             REFERENCES hotel_canonical(id),
      CONSTRAINT hotel_meal_plan_status_chk  CHECK (status IN ('ACTIVE', 'INACTIVE'))
    )
  `);

  // One platform-global meal plan per code (RO, BB, HB, FB, AI).
  await knex.raw(`
    CREATE UNIQUE INDEX hotel_meal_plan_global_code_uq
    ON hotel_meal_plan(code)
    WHERE canonical_hotel_id IS NULL
  `);

  // Per-hotel override uniqueness.
  await knex.raw(`
    CREATE UNIQUE INDEX hotel_meal_plan_hotel_code_uq
    ON hotel_meal_plan(canonical_hotel_id, code)
    WHERE canonical_hotel_id IS NOT NULL
  `);

  // --- hotel_rate_plan ---------------------------------------------------

  await knex.raw(`
    CREATE TABLE hotel_rate_plan (
      id                      CHAR(26)     NOT NULL,
      canonical_hotel_id      CHAR(26)     NOT NULL,
      code                    VARCHAR(64)  NOT NULL,
      name                    VARCHAR(255) NOT NULL,
      rate_class              VARCHAR(32)  NOT NULL,
      refundable              BOOLEAN      NOT NULL DEFAULT TRUE,
      meal_plan_default_code  VARCHAR(32),
      description             TEXT,
      status                  VARCHAR(32)  NOT NULL DEFAULT 'ACTIVE',
      created_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
      updated_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),

      CONSTRAINT hotel_rate_plan_pk              PRIMARY KEY (id),
      CONSTRAINT hotel_rate_plan_hotel_fk        FOREIGN KEY (canonical_hotel_id)
                                                 REFERENCES hotel_canonical(id),
      CONSTRAINT hotel_rate_plan_code_uq         UNIQUE (canonical_hotel_id, code),
      CONSTRAINT hotel_rate_plan_status_chk      CHECK (status IN ('ACTIVE', 'INACTIVE')),
      CONSTRAINT hotel_rate_plan_rate_class_chk  CHECK (rate_class IN (
                                                   'PUBLIC_BAR', 'ADVANCE_PURCHASE',
                                                   'NON_REFUNDABLE', 'MEMBER',
                                                   'CORPORATE', 'NEGOTIATED',
                                                   'OPAQUE_WHOLESALE'
                                                 ))
    )
  `);

  // --- hotel_occupancy_template ------------------------------------------

  await knex.raw(`
    CREATE TABLE hotel_occupancy_template (
      id                  CHAR(26)     NOT NULL,
      canonical_hotel_id  CHAR(26)     NOT NULL,
      room_type_id        CHAR(26)     NOT NULL,
      rate_plan_id        CHAR(26),
      base_adults         SMALLINT     NOT NULL,
      max_adults          SMALLINT     NOT NULL,
      max_children        SMALLINT     NOT NULL DEFAULT 0,
      max_total           SMALLINT     NOT NULL,
      standard_bedding    VARCHAR(64),
      created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
      updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),

      CONSTRAINT hotel_occupancy_template_pk            PRIMARY KEY (id),
      CONSTRAINT hotel_occupancy_template_hotel_fk      FOREIGN KEY (canonical_hotel_id)
                                                        REFERENCES hotel_canonical(id),
      CONSTRAINT hotel_occupancy_template_room_fk       FOREIGN KEY (room_type_id)
                                                        REFERENCES hotel_room_type(id),
      CONSTRAINT hotel_occupancy_template_rate_plan_fk  FOREIGN KEY (rate_plan_id)
                                                        REFERENCES hotel_rate_plan(id),
      CONSTRAINT hotel_occupancy_template_base_chk      CHECK (base_adults > 0),
      CONSTRAINT hotel_occupancy_template_max_chk       CHECK (max_total >= max_adults + max_children)
    )
  `);

  // One template per room-type, narrowable per rate plan.
  await knex.raw(`
    CREATE UNIQUE INDEX hotel_occupancy_template_room_default_uq
    ON hotel_occupancy_template(room_type_id)
    WHERE rate_plan_id IS NULL
  `);

  await knex.raw(`
    CREATE UNIQUE INDEX hotel_occupancy_template_room_rate_uq
    ON hotel_occupancy_template(room_type_id, rate_plan_id)
    WHERE rate_plan_id IS NOT NULL
  `);

  // --- hotel_child_age_band ----------------------------------------------

  await knex.raw(`
    CREATE TABLE hotel_child_age_band (
      id                  CHAR(26)     NOT NULL,
      canonical_hotel_id  CHAR(26)     NOT NULL,
      band_code           VARCHAR(32)  NOT NULL,
      min_age_inclusive   SMALLINT     NOT NULL,
      max_age_inclusive   SMALLINT     NOT NULL,
      status              VARCHAR(32)  NOT NULL DEFAULT 'ACTIVE',
      created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
      updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),

      CONSTRAINT hotel_child_age_band_pk           PRIMARY KEY (id),
      CONSTRAINT hotel_child_age_band_hotel_fk     FOREIGN KEY (canonical_hotel_id)
                                                   REFERENCES hotel_canonical(id),
      CONSTRAINT hotel_child_age_band_code_uq      UNIQUE (canonical_hotel_id, band_code),
      CONSTRAINT hotel_child_age_band_range_chk    CHECK (max_age_inclusive >= min_age_inclusive),
      CONSTRAINT hotel_child_age_band_ages_chk     CHECK (min_age_inclusive >= 0 AND max_age_inclusive <= 17),
      CONSTRAINT hotel_child_age_band_status_chk   CHECK (status IN ('ACTIVE', 'INACTIVE'))
    )
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP TABLE IF EXISTS hotel_child_age_band');
  await knex.raw('DROP TABLE IF EXISTS hotel_occupancy_template');
  await knex.raw('DROP TABLE IF EXISTS hotel_rate_plan');
  await knex.raw('DROP TABLE IF EXISTS hotel_meal_plan');
  await knex.raw('DROP TABLE IF EXISTS hotel_room_type');
}
