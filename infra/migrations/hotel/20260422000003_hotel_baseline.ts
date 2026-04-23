import type { Knex } from 'knex';

/**
 * Three tables for the canonical hotel model (ADR-002, ADR-008):
 *   hotel_canonical   — one row per real hotel, platform-wide (no tenant_id)
 *   hotel_supplier    — raw per-supplier hotel reference (SupplierHotelRef)
 *   hotel_mapping     — auditable, reversible link between the two (HotelMappingRecord)
 *
 * hotel_canonical has no tenant_id because one canonical hotel represents one real-world
 * property regardless of how many tenants source it. Tenant-specific catalog visibility
 * is handled by a separate table added in Phase 2+.
 */
export async function up(knex: Knex): Promise<void> {
  // --- hotel_canonical ---------------------------------------------------

  await knex.raw(`
    CREATE TABLE hotel_canonical (
      id              CHAR(26)     NOT NULL,
      name            VARCHAR(512) NOT NULL,
      chain_code      VARCHAR(64),
      star_rating     SMALLINT,
      address_line1   VARCHAR(255),
      address_city    VARCHAR(128),
      address_region  VARCHAR(128),
      address_country CHAR(2),
      address_postal  VARCHAR(32),
      geo             GEOMETRY(Point, 4326),
      mapping_status  VARCHAR(32)  NOT NULL DEFAULT 'PENDING',
      content         JSONB        NOT NULL DEFAULT '{}',
      status          VARCHAR(32)  NOT NULL DEFAULT 'ACTIVE',
      created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
      updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),

      CONSTRAINT hotel_canonical_pk                  PRIMARY KEY (id),
      CONSTRAINT hotel_canonical_star_rating_chk     CHECK (star_rating BETWEEN 1 AND 5),
      CONSTRAINT hotel_canonical_mapping_status_chk  CHECK (mapping_status IN
                                                       ('PENDING', 'MAPPED', 'CONFLICT', 'MANUAL_REVIEW')),
      CONSTRAINT hotel_canonical_status_chk          CHECK (status IN ('ACTIVE', 'CLOSED', 'DUPLICATE'))
    )
  `);

  await knex.raw(`
    CREATE INDEX hotel_canonical_geo_idx
    ON hotel_canonical USING GIST(geo)
  `);

  await knex.raw(`
    CREATE INDEX hotel_canonical_unmapped_idx
    ON hotel_canonical(mapping_status)
    WHERE mapping_status != 'MAPPED'
  `);

  await knex.raw(`
    CREATE INDEX hotel_canonical_country_idx
    ON hotel_canonical(address_country)
  `);

  // --- hotel_supplier ----------------------------------------------------

  await knex.raw(`
    CREATE TABLE hotel_supplier (
      id                   CHAR(26)     NOT NULL,
      supplier_id          CHAR(26)     NOT NULL,
      supplier_hotel_code  VARCHAR(128) NOT NULL,
      name                 VARCHAR(512) NOT NULL,
      address_country      CHAR(2),
      geo                  GEOMETRY(Point, 4326),
      raw_content          JSONB        NOT NULL DEFAULT '{}',
      status               VARCHAR(32)  NOT NULL DEFAULT 'ACTIVE',
      content_refreshed_at TIMESTAMPTZ,
      created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
      updated_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),

      CONSTRAINT hotel_supplier_pk           PRIMARY KEY (id),
      CONSTRAINT hotel_supplier_supplier_fk  FOREIGN KEY (supplier_id)
                                             REFERENCES supply_supplier(id),
      CONSTRAINT hotel_supplier_code_uq      UNIQUE (supplier_id, supplier_hotel_code),
      CONSTRAINT hotel_supplier_status_chk   CHECK (status IN ('ACTIVE', 'INACTIVE'))
    )
  `);

  await knex.raw(`
    CREATE INDEX hotel_supplier_supplier_idx
    ON hotel_supplier(supplier_id)
  `);

  await knex.raw(`
    CREATE INDEX hotel_supplier_geo_idx
    ON hotel_supplier USING GIST(geo)
  `);

  // --- hotel_mapping -----------------------------------------------------

  await knex.raw(`
    CREATE TABLE hotel_mapping (
      id                 CHAR(26)     NOT NULL,
      canonical_hotel_id CHAR(26)     NOT NULL,
      hotel_supplier_id  CHAR(26)     NOT NULL,
      confidence_score   NUMERIC(5,4),
      mapping_status     VARCHAR(32)  NOT NULL DEFAULT 'PENDING',
      mapping_method     VARCHAR(32)  NOT NULL DEFAULT 'DETERMINISTIC',
      raw_signals        JSONB        NOT NULL DEFAULT '{}',
      resolved_by        CHAR(26),
      superseded_by_id   CHAR(26),
      created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
      updated_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),

      CONSTRAINT hotel_mapping_pk              PRIMARY KEY (id),
      CONSTRAINT hotel_mapping_canonical_fk    FOREIGN KEY (canonical_hotel_id)
                                               REFERENCES hotel_canonical(id),
      CONSTRAINT hotel_mapping_supplier_fk     FOREIGN KEY (hotel_supplier_id)
                                               REFERENCES hotel_supplier(id),
      CONSTRAINT hotel_mapping_superseded_fk   FOREIGN KEY (superseded_by_id)
                                               REFERENCES hotel_mapping(id),
      CONSTRAINT hotel_mapping_confidence_chk  CHECK (confidence_score BETWEEN 0.0 AND 1.0),
      CONSTRAINT hotel_mapping_status_chk      CHECK (mapping_status IN
                                                 ('PENDING', 'CONFIRMED', 'REJECTED', 'SUPERSEDED')),
      CONSTRAINT hotel_mapping_method_chk      CHECK (mapping_method IN
                                                 ('DETERMINISTIC', 'FUZZY', 'MANUAL'))
    )
  `);

  // Each supplier hotel should have at most one active mapping at a time.
  // REJECTED and SUPERSEDED records are historical and excluded from the uniqueness constraint.
  await knex.raw(`
    CREATE UNIQUE INDEX hotel_mapping_active_supplier_uq
    ON hotel_mapping(hotel_supplier_id)
    WHERE mapping_status NOT IN ('REJECTED', 'SUPERSEDED')
  `);

  await knex.raw(`
    CREATE INDEX hotel_mapping_canonical_idx
    ON hotel_mapping(canonical_hotel_id)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP TABLE IF EXISTS hotel_mapping');
  await knex.raw('DROP TABLE IF EXISTS hotel_supplier');
  await knex.raw('DROP TABLE IF EXISTS hotel_canonical');
}
