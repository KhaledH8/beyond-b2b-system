import type { Knex } from 'knex';

/**
 * ADR-026 Slice E2-A — identity baseline.
 *
 * Two tables, additive. No role tables, no permission middleware, no
 * webhook ingestion logic, no Auth0 Management API integration. Those
 * arrive in E3 (`user_role`, `user_account_membership`, permission
 * middleware) and E2-B (admin provisioning, webhook ingestion,
 * bootstrap script).
 *
 *   - `core_user` — the application-side mirror of an Auth0 identity.
 *     Keyed to Auth0's `sub` claim. ADR-026 D1 splits identity (lives
 *     in Auth0) from role/scope/permission (live in our DB); this
 *     table is the bridge.
 *
 *   - `auth0_event_ingestion` — idempotency table for the future
 *     webhook ingestion path (E2-B). Created now so the `log_id` PK
 *     unique constraint exists when E2-B starts inserting; ingestion
 *     code is not in this slice.
 *
 * Locked design choices (ADR-026):
 *
 *   - Single-tenant launch, multi-tenant data model preserved.
 *     `tenant_id` NOT NULL on `core_user` even though there is one
 *     tenant in V1.
 *
 *   - One account per agency user (D11). The `user_account_membership`
 *     UNIQUE (user_id) constraint lands in E3, not here. Operator
 *     users have no membership row at all.
 *
 *   - `user_class` distinguishes OPERATOR and AGENCY (D5/D7); the role
 *     set permitted on a user is constrained by class. The class
 *     CHECK enforces that, role enforcement lands in E3.
 *
 *   - `auth0_sub` is the canonical identity handle (D1). UNIQUE so the
 *     same Auth0 identity cannot map to two `core_user` rows. NOT
 *     NULL because every user in the table corresponds to an Auth0
 *     identity — JIT provisioning is bootstrap-only (Slice E2-A
 *     locked rule), and admin-driven provisioning still creates the
 *     Auth0 user first.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE core_user (
      id            CHAR(26)      NOT NULL,
      tenant_id     CHAR(26)      NOT NULL,

      -- Canonical Auth0 identifier (the 'sub' claim). Examples:
      --   'auth0|abc123def456'
      --   'oidc|connection|stable_id'
      -- Auth0 documents 'sub' as up to 255 chars; we mirror that.
      auth0_sub     VARCHAR(255)  NOT NULL,

      -- Denormalized from Auth0 for query convenience. Refreshed on
      -- user-updated webhooks (E2-B). Email length cap follows
      -- RFC 5321: 64 local + '@' + 255 domain = 320.
      email         VARCHAR(320)  NOT NULL,

      display_name  VARCHAR(200),

      -- Determines which role set a user may hold (ADR-026 D5).
      -- OPERATOR users are tenant-scoped; AGENCY users are account-
      -- scoped via user_account_membership (E3).
      user_class    VARCHAR(16)   NOT NULL,

      status        VARCHAR(16)   NOT NULL DEFAULT 'ACTIVE',

      created_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
      updated_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),

      CONSTRAINT core_user_pk         PRIMARY KEY (id),

      CONSTRAINT core_user_tenant_fk  FOREIGN KEY (tenant_id)
                                      REFERENCES core_tenant(id),

      -- An Auth0 identity maps to at most one application user.
      CONSTRAINT core_user_auth0_sub_uq UNIQUE (auth0_sub),

      CONSTRAINT core_user_class_chk  CHECK (user_class IN ('OPERATOR', 'AGENCY')),

      CONSTRAINT core_user_status_chk CHECK (status IN ('ACTIVE', 'DEACTIVATED'))
    )
  `);

  await knex.raw(`
    CREATE INDEX core_user_tenant_idx
    ON core_user (tenant_id)
  `);

  // Per-tenant case-insensitive uniqueness on email. Same email can
  // appear in different tenants once multi-tenant ships; within a
  // single tenant it must be unique. lower() matches typical login
  // semantics (Auth0 normalizes to lowercase by default).
  await knex.raw(`
    CREATE UNIQUE INDEX core_user_email_per_tenant_uq
    ON core_user (tenant_id, lower(email))
  `);

  // Idempotency table for Auth0 Log Stream webhook ingestion (E2-B).
  // Created here so the constraint exists before any ingestion code
  // lands. Ingestion logic is NOT in this slice.
  await knex.raw(`
    CREATE TABLE auth0_event_ingestion (
      log_id        VARCHAR(255)  NOT NULL,
      event_type    VARCHAR(64)   NOT NULL,
      ingested_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),

      CONSTRAINT auth0_event_ingestion_pk PRIMARY KEY (log_id)
    )
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP TABLE IF EXISTS auth0_event_ingestion');
  await knex.raw('DROP TABLE IF EXISTS core_user');
}
