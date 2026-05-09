import type { Knex } from 'knex';

/**
 * ADR-028 Step 2 — audit_event composite-partitioned table.
 *
 * Creates:
 *   1. audit_event parent (LIST-partitioned by category).
 *   2. Five category-intermediate tables, each RANGE-partitioned by
 *      occurred_at: audit_event_{app,auth,impersonation,
 *      sensitive_access,security}.
 *   3. Monthly leaf partitions for the current and next calendar month
 *      across all five category trees (10 leaf tables total at
 *      migration time). A cron job creates subsequent months one
 *      month ahead of write demand (ADR-028 D8).
 *   4. append-only triggers (BEFORE UPDATE, BEFORE DELETE) on the
 *      parent table. Postgres 13+ propagates row-level triggers to
 *      existing and future partitions automatically.
 *   5. Five indexes on the parent (Postgres propagates to each leaf).
 *   6. Role grants for bb_app and bb_audit_retention.
 *
 * COMPOSITE PARTITION SCHEME (ADR-028 D3):
 *
 *   audit_event                           ← parent (LIST by category)
 *   ├─ audit_event_app                    ← intermediate (RANGE by occurred_at)
 *   │  └─ audit_event_app_YYYY_MM         ← leaf (one per month)
 *   ├─ audit_event_auth
 *   │  └─ audit_event_auth_YYYY_MM
 *   ├─ audit_event_impersonation
 *   │  └─ audit_event_impersonation_YYYY_MM
 *   ├─ audit_event_sensitive_access
 *   │  └─ audit_event_sensitive_access_YYYY_MM
 *   └─ audit_event_security
 *      └─ audit_event_security_YYYY_MM
 *
 * This ensures each drop unit (monthly leaf) belongs to exactly one
 * retention window; categories with different retention periods
 * (e.g. SECURITY at 2 years vs AUTH at 7 years) are never co-mingled.
 *
 * APPEND-ONLY ENFORCEMENT:
 *
 *   The BEFORE UPDATE and BEFORE DELETE triggers fire for ALL roles,
 *   including the table owner (bb_admin). The triggers are the
 *   defence-in-depth layer; the primary layer in production is the
 *   bb_app role lacking UPDATE/DELETE/TRUNCATE.
 *
 *   In local dev and CI the app connects as the owner user ("bb") and
 *   the role restriction does not apply — the trigger is the sole
 *   enforcer in those environments. See step 1 migration for details.
 *
 * PRIMARY KEY:
 *
 *   (id, category, occurred_at) — Postgres requires all partition
 *   columns to appear in the primary key of a partitioned table.
 *   category and occurred_at are included to satisfy the constraint;
 *   id alone is unique per the application's ULID generation.
 */
export async function up(knex: Knex): Promise<void> {
  // ── 1. Parent table ──────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE audit_event (
      id                     CHAR(26)     NOT NULL,
      occurred_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
      recorded_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
      schema_version         SMALLINT     NOT NULL,

      category               VARCHAR(24)  NOT NULL,
      kind                   VARCHAR(64)  NOT NULL,

      tenant_id              CHAR(26)     NOT NULL,

      actor_kind             VARCHAR(16)  NOT NULL,
      actor_user_id          CHAR(26),
      actor_api_key_id       CHAR(26),
      actor_label            VARCHAR(120),

      target_kind            VARCHAR(32),
      target_id              VARCHAR(64),

      request_id             CHAR(26),
      impersonation_grant_id CHAR(26),
      ip_address             INET,
      user_agent             TEXT,

      payload                JSONB        NOT NULL DEFAULT '{}'::jsonb,

      CONSTRAINT audit_event_pk PRIMARY KEY (id, category, occurred_at),

      CONSTRAINT audit_event_category_chk CHECK (category IN
        ('APP', 'AUTH', 'IMPERSONATION', 'SENSITIVE_ACCESS', 'SECURITY')),

      CONSTRAINT audit_event_actor_kind_chk CHECK (actor_kind IN
        ('USER', 'API_CONSUMER', 'INTERNAL', 'ANONYMOUS')),

      CONSTRAINT audit_event_actor_user_chk CHECK (
        (actor_kind = 'USER' AND actor_user_id IS NOT NULL)
        OR (actor_kind <> 'USER' AND actor_user_id IS NULL)
      ),

      CONSTRAINT audit_event_actor_api_key_chk CHECK (
        (actor_kind = 'API_CONSUMER' AND actor_api_key_id IS NOT NULL)
        OR (actor_kind <> 'API_CONSUMER' AND actor_api_key_id IS NULL)
      ),

      CONSTRAINT audit_event_payload_size_chk
        CHECK (octet_length(payload::text) <= 65536),

      CONSTRAINT audit_event_schema_version_chk
        CHECK (schema_version >= 1)

    ) PARTITION BY LIST (category)
  `);

  // ── 2. Category-intermediate partitions ──────────────────────────
  await knex.raw(`
    CREATE TABLE audit_event_app PARTITION OF audit_event
      FOR VALUES IN ('APP')
      PARTITION BY RANGE (occurred_at)
  `);

  await knex.raw(`
    CREATE TABLE audit_event_auth PARTITION OF audit_event
      FOR VALUES IN ('AUTH')
      PARTITION BY RANGE (occurred_at)
  `);

  await knex.raw(`
    CREATE TABLE audit_event_impersonation PARTITION OF audit_event
      FOR VALUES IN ('IMPERSONATION')
      PARTITION BY RANGE (occurred_at)
  `);

  await knex.raw(`
    CREATE TABLE audit_event_sensitive_access PARTITION OF audit_event
      FOR VALUES IN ('SENSITIVE_ACCESS')
      PARTITION BY RANGE (occurred_at)
  `);

  await knex.raw(`
    CREATE TABLE audit_event_security PARTITION OF audit_event
      FOR VALUES IN ('SECURITY')
      PARTITION BY RANGE (occurred_at)
  `);

  // ── 3. Monthly leaf partitions — current and next month ──────────
  // Computed at migration execution time. Subsequent months are
  // created by a cron job one month ahead of write demand (ADR-028 D8).
  await knex.raw(`
    DO $$
    DECLARE
      v_cur   DATE   := date_trunc('month', now())::date;
      v_next  DATE   := (date_trunc('month', now()) + interval '1 month')::date;
      v_after DATE   := (date_trunc('month', now()) + interval '2 months')::date;
      cats    TEXT[] := ARRAY['app','auth','impersonation','sensitive_access','security'];
      cat     TEXT;
    BEGIN
      FOREACH cat IN ARRAY cats LOOP
        -- current month
        EXECUTE format(
          'CREATE TABLE audit_event_%s_%s
             PARTITION OF audit_event_%s
             FOR VALUES FROM (%L) TO (%L)',
          cat, to_char(v_cur,  'YYYY_MM'), cat,
          v_cur::text, v_next::text
        );
        -- next month
        EXECUTE format(
          'CREATE TABLE audit_event_%s_%s
             PARTITION OF audit_event_%s
             FOR VALUES FROM (%L) TO (%L)',
          cat, to_char(v_next, 'YYYY_MM'), cat,
          v_next::text, v_after::text
        );
      END LOOP;
    END $$
  `);

  // ── 4. Append-only enforcement ────────────────────────────────────
  // Trigger function. OR REPLACE so re-running the migration (e.g.
  // after a down/up cycle) does not fail.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION audit_event_no_mutation()
    RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION
        'audit_event is append-only; mutation on %.% is forbidden',
        TG_TABLE_SCHEMA, TG_TABLE_NAME;
    END;
    $$ LANGUAGE plpgsql
  `);

  // Triggers on the parent — Postgres 13+ propagates row-level
  // triggers to all existing and future partitions automatically.
  await knex.raw(`
    CREATE TRIGGER audit_event_no_update
      BEFORE UPDATE ON audit_event
      FOR EACH ROW EXECUTE FUNCTION audit_event_no_mutation()
  `);

  await knex.raw(`
    CREATE TRIGGER audit_event_no_delete
      BEFORE DELETE ON audit_event
      FOR EACH ROW EXECUTE FUNCTION audit_event_no_mutation()
  `);

  // ── 5. Indexes (parent; Postgres propagates to each leaf) ─────────
  await knex.raw(`
    CREATE INDEX audit_event_actor_user_idx
      ON audit_event (actor_user_id, occurred_at DESC)
      WHERE actor_user_id IS NOT NULL
  `);

  await knex.raw(`
    CREATE INDEX audit_event_target_idx
      ON audit_event (target_kind, target_id, occurred_at DESC)
      WHERE target_id IS NOT NULL
  `);

  await knex.raw(`
    CREATE INDEX audit_event_request_idx
      ON audit_event (request_id)
      WHERE request_id IS NOT NULL
  `);

  await knex.raw(`
    CREATE INDEX audit_event_impersonation_idx
      ON audit_event (impersonation_grant_id, occurred_at DESC)
      WHERE impersonation_grant_id IS NOT NULL
  `);

  // kind index: category redundant due to partition pruning (ADR-028 D3).
  await knex.raw(`
    CREATE INDEX audit_event_kind_idx
      ON audit_event (kind, occurred_at DESC)
  `);

  // ── 6. Role grants ────────────────────────────────────────────────
  // bb_app: INSERT + SELECT only. UPDATE, DELETE, TRUNCATE are never
  // granted. Grants on the parent cascade to all partitions.
  // Wrapped in DO block so the migration succeeds in local dev where
  // these roles exist (step 1 created them) but the app still
  // connects as the owner user.
  await knex.raw(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT FROM pg_catalog.pg_roles WHERE rolname = 'bb_app'
      ) THEN
        GRANT INSERT, SELECT ON audit_event TO bb_app;
      END IF;

      -- bb_audit_retention drops partitions via DDL (DROP TABLE),
      -- not via row-level DELETE. SELECT access lets the retention
      -- job read row counts before dropping.
      IF EXISTS (
        SELECT FROM pg_catalog.pg_roles WHERE rolname = 'bb_audit_retention'
      ) THEN
        GRANT SELECT ON audit_event TO bb_audit_retention;
      END IF;
    END $$
  `);
}

export async function down(knex: Knex): Promise<void> {
  // Dropping the parent CASCADE removes all intermediate and leaf
  // partitions plus all triggers and indexes on them.
  await knex.raw('DROP TABLE IF EXISTS audit_event CASCADE');
  // The trigger function is not owned by the table; drop separately.
  await knex.raw('DROP FUNCTION IF EXISTS audit_event_no_mutation() CASCADE');
}
