import type { Knex } from 'knex';

/**
 * `admin_audit_log` — immutable record of every mutating internal
 * admin operation (CREATE / PATCH / SOFT_DELETE) on pricing and
 * merchandising configuration rows.
 *
 * Each row captures:
 *   - who performed the operation (actor_id from X-Actor-Id header,
 *     or 'anonymous' when the header is absent)
 *   - which resource was affected (resource_type + resource_id)
 *   - what changed (payload = the input that caused the write)
 *   - when it happened (created_at, immutable)
 *
 * Rows are never updated or deleted. Corrections appear as new rows
 * with the correcting operation recorded alongside the original.
 *
 * tenant_id is included so audit queries stay tenant-scoped without
 * JOINing back to the resource table.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE admin_audit_log (
      id            CHAR(26)      NOT NULL,
      tenant_id     CHAR(26)      NOT NULL,
      actor_id      VARCHAR(255)  NOT NULL,
      resource_type VARCHAR(64)   NOT NULL,
      resource_id   CHAR(26)      NOT NULL,
      operation     VARCHAR(32)   NOT NULL,
      payload       JSONB         NOT NULL DEFAULT '{}',
      created_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),

      CONSTRAINT admin_audit_log_pk         PRIMARY KEY (id),
      CONSTRAINT admin_audit_log_tenant_fk  FOREIGN KEY (tenant_id)
                                            REFERENCES core_tenant(id),
      CONSTRAINT admin_audit_log_op_chk     CHECK (
        operation IN ('CREATE', 'PATCH', 'SOFT_DELETE')
      )
    )
  `);

  // Audit trail for one resource: all changes to a specific row.
  await knex.raw(`
    CREATE INDEX admin_audit_log_resource_idx
    ON admin_audit_log(tenant_id, resource_type, resource_id, created_at DESC)
  `);

  // Recent activity across a tenant (ops dashboard, incident response).
  await knex.raw(`
    CREATE INDEX admin_audit_log_tenant_time_idx
    ON admin_audit_log(tenant_id, created_at DESC)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP TABLE IF EXISTS admin_audit_log');
}
