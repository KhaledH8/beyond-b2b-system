import type { Knex } from 'knex';

/**
 * Aligns the merchandising promotion table with the ADR-011 `merch_`
 * table-prefix convention. The original migration created the table as
 * `merchandising_promotion` (full word); ADR-011 §"existing prefix
 * ownership rules" specifies the abbreviated `merch_` prefix.
 *
 * All constraints and indexes are renamed for consistency. Code
 * references updated in the same commit.
 */
export async function up(knex: Knex): Promise<void> {
  // Rename indexes before the table (Postgres resolves index names
  // independently of table name, so order does not matter, but doing
  // indexes first makes the migration read top-down clearly).
  await knex.raw(
    `ALTER INDEX merchandising_promotion_hotel_idx
       RENAME TO merch_promotion_hotel_idx`,
  );
  await knex.raw(
    `ALTER INDEX merchandising_promotion_channel_idx
       RENAME TO merch_promotion_channel_idx`,
  );

  // Rename each constraint individually — Postgres requires one
  // RENAME CONSTRAINT per ALTER TABLE statement.
  await knex.raw(
    `ALTER TABLE merchandising_promotion
       RENAME CONSTRAINT merchandising_promotion_pk TO merch_promotion_pk`,
  );
  await knex.raw(
    `ALTER TABLE merchandising_promotion
       RENAME CONSTRAINT merchandising_promotion_tenant_fk TO merch_promotion_tenant_fk`,
  );
  await knex.raw(
    `ALTER TABLE merchandising_promotion
       RENAME CONSTRAINT merchandising_promotion_hotel_fk TO merch_promotion_hotel_fk`,
  );
  await knex.raw(
    `ALTER TABLE merchandising_promotion
       RENAME CONSTRAINT merchandising_promotion_kind_chk TO merch_promotion_kind_chk`,
  );
  await knex.raw(
    `ALTER TABLE merchandising_promotion
       RENAME CONSTRAINT merchandising_promotion_status_chk TO merch_promotion_status_chk`,
  );
  await knex.raw(
    `ALTER TABLE merchandising_promotion
       RENAME CONSTRAINT merchandising_promotion_acct_type_chk TO merch_promotion_acct_type_chk`,
  );
  await knex.raw(
    `ALTER TABLE merchandising_promotion
       RENAME CONSTRAINT merchandising_promotion_validity_chk TO merch_promotion_validity_chk`,
  );

  // Rename the table itself last.
  await knex.raw(
    `ALTER TABLE merchandising_promotion RENAME TO merch_promotion`,
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE merch_promotion RENAME TO merchandising_promotion`);

  await knex.raw(
    `ALTER TABLE merchandising_promotion
       RENAME CONSTRAINT merch_promotion_pk TO merchandising_promotion_pk`,
  );
  await knex.raw(
    `ALTER TABLE merchandising_promotion
       RENAME CONSTRAINT merch_promotion_tenant_fk TO merchandising_promotion_tenant_fk`,
  );
  await knex.raw(
    `ALTER TABLE merchandising_promotion
       RENAME CONSTRAINT merch_promotion_hotel_fk TO merchandising_promotion_hotel_fk`,
  );
  await knex.raw(
    `ALTER TABLE merchandising_promotion
       RENAME CONSTRAINT merch_promotion_kind_chk TO merchandising_promotion_kind_chk`,
  );
  await knex.raw(
    `ALTER TABLE merchandising_promotion
       RENAME CONSTRAINT merch_promotion_status_chk TO merchandising_promotion_status_chk`,
  );
  await knex.raw(
    `ALTER TABLE merchandising_promotion
       RENAME CONSTRAINT merch_promotion_acct_type_chk TO merchandising_promotion_acct_type_chk`,
  );
  await knex.raw(
    `ALTER TABLE merchandising_promotion
       RENAME CONSTRAINT merch_promotion_validity_chk TO merchandising_promotion_validity_chk`,
  );

  await knex.raw(
    `ALTER INDEX merch_promotion_hotel_idx
       RENAME TO merchandising_promotion_hotel_idx`,
  );
  await knex.raw(
    `ALTER INDEX merch_promotion_channel_idx
       RENAME TO merchandising_promotion_channel_idx`,
  );
}
