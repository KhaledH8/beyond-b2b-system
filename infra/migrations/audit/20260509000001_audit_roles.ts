import type { Knex } from 'knex';

/**
 * ADR-028 Step 1 — Postgres role separation for the audit substrate.
 *
 * Three roles (ADR-028 D2.a):
 *
 *   bb_app             — role the API connects as in production.
 *                        Granted INSERT, SELECT on audit tables only.
 *                        NOT granted UPDATE, DELETE, or TRUNCATE.
 *
 *   bb_audit_retention — role used exclusively by the retention job.
 *                        Drops leaf partitions via DDL (not row DELETE).
 *                        Granted INSERT, SELECT on audit_pruning_log.
 *                        Never used by the API.
 *
 *   bb_admin           — migration / DDL role; used only by the
 *                        deployment pipeline. Owns the audit tables.
 *
 * LOCAL DEV / CI LIMITATION — documented per ADR-028 Consequences:
 *
 *   In local development and CI the database is accessed by a single
 *   Postgres user ("bb") which owns all objects and is not subject to
 *   the GRANT restrictions here. The three roles are created
 *   idempotently but the app does NOT connect as bb_app in those
 *   environments.
 *
 *   Consequence: the role-level restriction (bb_app has only INSERT +
 *   SELECT) is NOT enforced locally or in CI. The append-only
 *   invariant in those environments relies entirely on the BEFORE
 *   UPDATE / BEFORE DELETE triggers installed in step 2, which fire
 *   for ALL roles including the table owner.
 *
 *   In production the app connects as bb_app and the role restriction
 *   is the primary defence; the trigger is secondary (defence in
 *   depth). Verify this distinction before the first production
 *   deployment.
 *
 * GRANT statements for specific tables live in the migrations that
 * create those tables (steps 2 and 3), not here.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT FROM pg_catalog.pg_roles WHERE rolname = 'bb_app'
      ) THEN
        CREATE ROLE bb_app NOLOGIN;
      END IF;

      IF NOT EXISTS (
        SELECT FROM pg_catalog.pg_roles WHERE rolname = 'bb_audit_retention'
      ) THEN
        CREATE ROLE bb_audit_retention NOLOGIN;
      END IF;

      IF NOT EXISTS (
        SELECT FROM pg_catalog.pg_roles WHERE rolname = 'bb_admin'
      ) THEN
        CREATE ROLE bb_admin NOLOGIN;
      END IF;
    END $$
  `);
}

export async function down(_knex: Knex): Promise<void> {
  // Roles are cluster-scoped objects. Dropping them here risks
  // breaking other databases on the same cluster or ongoing sessions.
  // Role removal is a deliberate manual DBA operation documented in
  // the decommissioning runbook — not reversed by a migration rollback.
}
