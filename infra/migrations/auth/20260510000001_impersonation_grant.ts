import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE impersonation_grant (
      id                 CHAR(26)     NOT NULL,
      tenant_id          CHAR(26)     NOT NULL REFERENCES core_tenant(id),

      -- Actor: an OPERATOR user holding IMPERSONATE_AGENCY_ACCOUNT.
      actor_user_id      CHAR(26)     NOT NULL REFERENCES core_user(id),

      -- Target: an AGENCY account in the same tenant (application-enforced).
      target_account_id  CHAR(26)     NOT NULL REFERENCES core_account(id),

      -- Why. Both required in V1 (ADR-027 D5).
      reason_text        TEXT         NOT NULL,
      ticket_ref         VARCHAR(100) NOT NULL,

      -- Capability scope. V1 only ever 'READ_ONLY'.
      scope              VARCHAR(16)  NOT NULL DEFAULT 'READ_ONLY',

      -- Lifecycle.
      started_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
      expires_at         TIMESTAMPTZ  NOT NULL,
      ended_at           TIMESTAMPTZ,
      ended_reason       VARCHAR(32),

      -- Provenance captured at start; never updated.
      ip_address         INET,
      user_agent         TEXT,

      CONSTRAINT impersonation_grant_pk
        PRIMARY KEY (id),

      CONSTRAINT impersonation_grant_scope_chk
        CHECK (scope IN ('READ_ONLY')),

      CONSTRAINT impersonation_grant_lifecycle_chk
        CHECK (ended_at IS NULL OR ended_at >= started_at),

      CONSTRAINT impersonation_grant_window_chk
        CHECK (expires_at > started_at),

      CONSTRAINT impersonation_grant_ended_reason_chk
        CHECK (
          (ended_at IS NULL AND ended_reason IS NULL)
          OR (ended_at IS NOT NULL AND ended_reason IN
              ('OPERATOR_ENDED', 'EXPIRED', 'ADMIN_REVOKED'))
        )
    )
  `);

  // One un-ended grant per actor — the schema is the authority (ADR-027 D4).
  await knex.raw(`
    CREATE UNIQUE INDEX impersonation_grant_actor_active_uq
      ON impersonation_grant (actor_user_id) WHERE ended_at IS NULL
  `);

  // Hot path: per-actor active grant lookup on every OPERATOR request.
  await knex.raw(`
    CREATE INDEX impersonation_grant_actor_lookup_idx
      ON impersonation_grant (actor_user_id, ended_at, expires_at)
  `);

  // Admin/audit views by target account.
  await knex.raw(`
    CREATE INDEX impersonation_grant_target_idx
      ON impersonation_grant (target_account_id, started_at DESC)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP TABLE IF EXISTS impersonation_grant CASCADE');
}
