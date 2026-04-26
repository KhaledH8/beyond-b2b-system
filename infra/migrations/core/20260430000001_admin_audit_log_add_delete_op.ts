import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE admin_audit_log
      DROP CONSTRAINT admin_audit_log_op_chk,
      ADD CONSTRAINT admin_audit_log_op_chk
        CHECK (operation IN ('CREATE', 'PATCH', 'SOFT_DELETE', 'DELETE'))
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE admin_audit_log
      DROP CONSTRAINT admin_audit_log_op_chk,
      ADD CONSTRAINT admin_audit_log_op_chk
        CHECK (operation IN ('CREATE', 'PATCH', 'SOFT_DELETE'))
  `);
}
