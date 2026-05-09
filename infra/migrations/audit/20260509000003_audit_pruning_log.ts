import type { Knex } from 'knex';

/**
 * ADR-028 Step 3 — audit_pruning_log.
 *
 * A standalone, never-partitioned, never-pruned table that records
 * every audit_event leaf-partition drop (ADR-028 D2.d).
 *
 * The retention job (running as bb_audit_retention) MUST write a row
 * here BEFORE issuing DROP TABLE on a leaf partition. If the INSERT
 * fails, the DROP is not executed — the job aborts and alerts.
 *
 * Maximum size over 7 years: 5 categories × 12 months × 7 years =
 * 420 rows. Negligible. This table is never pruned.
 *
 * Grants:
 *   bb_audit_retention — INSERT, SELECT only. No DELETE.
 *   bb_app             — SELECT only (future read API includes pruning
 *                        history in audit investigations).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE audit_pruning_log (
      id               CHAR(26)     NOT NULL,
      pruned_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
      partition_name   TEXT         NOT NULL,
      category         VARCHAR(24)  NOT NULL,
      partition_month  DATE         NOT NULL,
      row_count_est    BIGINT,
      retention_rule   TEXT         NOT NULL,
      dropped_by_role  TEXT         NOT NULL DEFAULT current_role,

      CONSTRAINT audit_pruning_log_pk PRIMARY KEY (id),

      CONSTRAINT audit_pruning_log_category_chk CHECK (category IN
        ('APP', 'AUTH', 'IMPERSONATION', 'SENSITIVE_ACCESS', 'SECURITY'))
    )
  `);

  await knex.raw(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT FROM pg_catalog.pg_roles WHERE rolname = 'bb_audit_retention'
      ) THEN
        GRANT INSERT, SELECT ON audit_pruning_log TO bb_audit_retention;
      END IF;

      IF EXISTS (
        SELECT FROM pg_catalog.pg_roles WHERE rolname = 'bb_app'
      ) THEN
        GRANT SELECT ON audit_pruning_log TO bb_app;
      END IF;
    END $$
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP TABLE IF EXISTS audit_pruning_log');
}
