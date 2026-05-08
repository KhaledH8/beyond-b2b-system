import type { Knex } from 'knex';

/**
 * ADR-026 Slice E3-A — role/membership schema.
 *
 * Two tables, additive. No application code consuming them yet
 * beyond the read-side `PermissionResolverService` shipping in this
 * slice; write-side flows (admin role grants, user invitations)
 * arrive in E2-B and E10.
 *
 *   - `user_role`              — append-only role grants per user.
 *                                Active grant = `revoked_at IS NULL`.
 *                                Revoke writes timestamps; never deletes.
 *
 *   - `user_account_membership` — single-account-per-user binding for
 *                                AGENCY users. The UNIQUE (user_id)
 *                                constraint IS the V1 lock from
 *                                ADR-026 D11. Loosening it requires
 *                                a deliberate ADR amendment.
 *
 * Locked design choices (ADR-026):
 *
 *   - No `tenant_id` column on either table. Both join to `core_user`
 *     for tenant scope; denormalization is deferred until query
 *     performance demands it.
 *
 *   - The role enum lists only roles a `core_user` can hold. `api_consumer`
 *     (D5) is intentionally absent — API keys are account-bound, not
 *     user-bound (D3). Slice E7 introduces the `api_key` table with
 *     its own scope semantics.
 *
 *   - `granted_by IS NULL` is permitted (CHECK does not forbid it).
 *     The only legitimate NULL is the bootstrap `platform_admin`'s
 *     first grant (E2-B bootstrap script). Application invariant:
 *     every other grant carries a non-null granter.
 *
 *   - The "OPERATOR has zero memberships, AGENCY has exactly one"
 *     class-coherence invariant is application-enforced (ADR-026 §C.5).
 *     A SQL trigger could enforce it but adds operational surface;
 *     the application boundary (`PermissionResolverService` and the
 *     future provisioning service) is the source of truth.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE user_role (
      id            CHAR(26)      NOT NULL,
      user_id       CHAR(26)      NOT NULL,
      role          VARCHAR(32)   NOT NULL,

      -- The user who granted this role. NULL only for the bootstrap
      -- platform_admin's initial self-grant (E2-B); every other grant
      -- must carry a granter.
      granted_by    CHAR(26),
      granted_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),

      revoked_by    CHAR(26),
      revoked_at    TIMESTAMPTZ,

      CONSTRAINT user_role_pk         PRIMARY KEY (id),

      CONSTRAINT user_role_user_fk    FOREIGN KEY (user_id)
                                      REFERENCES core_user(id)
                                      ON DELETE CASCADE,

      CONSTRAINT user_role_grantor_fk FOREIGN KEY (granted_by)
                                      REFERENCES core_user(id),

      CONSTRAINT user_role_revoker_fk FOREIGN KEY (revoked_by)
                                      REFERENCES core_user(id),

      -- ADR-026 D4 + D5. api_consumer is NOT here on purpose.
      CONSTRAINT user_role_role_chk   CHECK (role IN (
                                        'platform_admin', 'ops_support',
                                        'finance_ops', 'integrations_ops',
                                        'read_only_auditor',
                                        'account_admin', 'booker', 'finance'
                                      )),

      -- Revoke is an atomic event: both columns set together or neither.
      CONSTRAINT user_role_revoke_chk CHECK (
        (revoked_at IS NULL  AND revoked_by IS NULL)
        OR
        (revoked_at IS NOT NULL AND revoked_by IS NOT NULL)
      )
    )
  `);

  // At most one ACTIVE grant of a given role per user. Re-grant after
  // revoke produces a new row (preserving history); the partial unique
  // index permits that without violating the constraint.
  await knex.raw(`
    CREATE UNIQUE INDEX user_role_active_uq
    ON user_role (user_id, role)
    WHERE revoked_at IS NULL
  `);

  await knex.raw(`
    CREATE INDEX user_role_user_idx
    ON user_role (user_id)
  `);

  // Reverse-lookup support: "find every active grant of role X."
  // Useful for the role-grant audit dashboard (E10) and ad-hoc ops
  // queries ("who currently holds platform_admin?").
  await knex.raw(`
    CREATE INDEX user_role_role_active_idx
    ON user_role (role)
    WHERE revoked_at IS NULL
  `);

  await knex.raw(`
    CREATE TABLE user_account_membership (
      id            CHAR(26)      NOT NULL,
      user_id       CHAR(26)      NOT NULL,
      account_id    CHAR(26)      NOT NULL,
      status        VARCHAR(16)   NOT NULL DEFAULT 'ACTIVE',
      created_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),

      CONSTRAINT uam_pk            PRIMARY KEY (id),

      CONSTRAINT uam_user_fk       FOREIGN KEY (user_id)
                                   REFERENCES core_user(id)
                                   ON DELETE CASCADE,

      CONSTRAINT uam_account_fk    FOREIGN KEY (account_id)
                                   REFERENCES core_account(id),

      CONSTRAINT uam_status_chk    CHECK (status IN ('ACTIVE', 'INACTIVE')),

      -- THE V1 lock (ADR-026 D11). Each agency user belongs to
      -- exactly one account. Loosening this requires an ADR
      -- amendment, not an inline relaxation.
      CONSTRAINT uam_one_per_user  UNIQUE (user_id)
    )
  `);

  await knex.raw(`
    CREATE INDEX uam_account_idx
    ON user_account_membership (account_id)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP TABLE IF EXISTS user_account_membership');
  await knex.raw('DROP TABLE IF EXISTS user_role');
}
