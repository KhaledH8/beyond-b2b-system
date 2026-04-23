import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // PostGIS must be enabled before any GEOMETRY columns are created.
  // postgis/postgis Docker image installs the extension server-side;
  // this activates it in the beyond_borders database.
  await knex.raw('CREATE EXTENSION IF NOT EXISTS postgis');

  await knex.raw(`
    CREATE TABLE core_tenant (
      id           CHAR(26)     NOT NULL,
      slug         VARCHAR(63)  NOT NULL,
      display_name VARCHAR(255) NOT NULL,
      status       VARCHAR(32)  NOT NULL DEFAULT 'ACTIVE',
      settings     JSONB        NOT NULL DEFAULT '{}',
      created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
      updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),

      CONSTRAINT core_tenant_pk             PRIMARY KEY (id),
      CONSTRAINT core_tenant_slug_uq        UNIQUE (slug),
      CONSTRAINT core_tenant_status_chk     CHECK (status IN ('ACTIVE', 'SUSPENDED', 'ARCHIVED'))
    )
  `);

  await knex.raw(`
    CREATE TABLE core_account (
      id                CHAR(26)     NOT NULL,
      tenant_id         CHAR(26)     NOT NULL,
      account_type      VARCHAR(32)  NOT NULL,
      name              VARCHAR(255) NOT NULL,
      parent_account_id CHAR(26),
      status            VARCHAR(32)  NOT NULL DEFAULT 'ACTIVE',
      settings          JSONB        NOT NULL DEFAULT '{}',
      created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
      updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),

      CONSTRAINT core_account_pk            PRIMARY KEY (id),
      CONSTRAINT core_account_tenant_fk     FOREIGN KEY (tenant_id)
                                            REFERENCES core_tenant(id),
      CONSTRAINT core_account_parent_fk     FOREIGN KEY (parent_account_id)
                                            REFERENCES core_account(id),
      CONSTRAINT core_account_type_chk      CHECK (account_type IN
                                              ('B2C', 'AGENCY', 'SUBSCRIBER', 'CORPORATE')),
      CONSTRAINT core_account_status_chk    CHECK (status IN ('ACTIVE', 'SUSPENDED', 'CLOSED'))
    )
  `);

  await knex.raw(`
    CREATE INDEX core_account_tenant_idx
    ON core_account(tenant_id)
  `);

  await knex.raw(`
    CREATE INDEX core_account_parent_idx
    ON core_account(parent_account_id)
    WHERE parent_account_id IS NOT NULL
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP TABLE IF EXISTS core_account');
  await knex.raw('DROP TABLE IF EXISTS core_tenant');
}
