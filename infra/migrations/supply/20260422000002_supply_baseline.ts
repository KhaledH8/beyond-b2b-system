import type { Knex } from 'knex';

/**
 * Minimal supply_supplier table — static metadata only.
 * Full supply tables (supply_connection, supply_direct_contract, etc.)
 * are added when the first supplier adapter ships in Phase 1.
 * hotel_supplier and hotel_mapping depend on this table via FK.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE supply_supplier (
      id           CHAR(26)     NOT NULL,
      code         VARCHAR(64)  NOT NULL,
      display_name VARCHAR(255) NOT NULL,
      source_type  VARCHAR(32)  NOT NULL,
      status       VARCHAR(32)  NOT NULL DEFAULT 'ACTIVE',
      created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
      updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),

      CONSTRAINT supply_supplier_pk              PRIMARY KEY (id),
      CONSTRAINT supply_supplier_code_uq         UNIQUE (code),
      CONSTRAINT supply_supplier_source_type_chk CHECK (source_type IN ('AGGREGATOR', 'DIRECT')),
      CONSTRAINT supply_supplier_status_chk      CHECK (status IN ('ACTIVE', 'INACTIVE', 'DEPRECATED'))
    )
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP TABLE IF EXISTS supply_supplier');
}
