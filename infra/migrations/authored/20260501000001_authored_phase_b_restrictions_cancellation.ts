import type { Knex } from 'knex';

/**
 * ADR-023 Phase B: authored direct pricing — restrictions and
 * cancellation policies. Schema only. No service code, no evaluator,
 * no search integration in this slice.
 *
 * Two tables:
 *   1. rate_auth_restriction          → ADR-023 D1, D2, D3, D4
 *   2. rate_auth_cancellation_policy  → ADR-023 D1, D5
 *
 * FK structure:
 *   - rate_auth_restriction reuses the composite-FK target on
 *     rate_auth_season(id, contract_id) established in ADR-022 D3.
 *     With the column pair nullable, MATCH SIMPLE (default) skips
 *     the FK check when either side is NULL — correct for both the
 *     supplier-default case (contract_id NULL) and the contract-wide
 *     case (season_id NULL). When both are non-null the composite is
 *     enforced, blocking cross-contract season references at the DB
 *     layer (ADR-022 D4).
 *   - Each table has a self-FK on superseded_by_id for the supersede
 *     chain (ADR-023 D8).
 *
 * Constraint scope (resolved inconsistency in ADR-023 D3):
 *   ADR-023 D3 contains two sentences that disagree about whether
 *   STOP_SELL / CTA / CTD must carry a DB CHECK enforcing
 *   `params = '{}'`. The closing summary in the same section says
 *   "The DB CHECK validates restriction_kind values only; params
 *   validation is the service's responsibility..." That summary is
 *   authoritative for this migration: the only DB CHECKs added here
 *   are the restriction_kind enum, the policy_version >= 1 sanity
 *   guard, and the effective_to >= effective_from sanity guard
 *   (analog of rate_auth_season_dates_chk and
 *   rate_auth_contract_window_chk from ADR-022). Per-kind params
 *   shape, windows_jsonb structure, and policy_version uniqueness
 *   per scope are all enforced by the service layer in Slice B2/B3.
 *
 * Hard delete is NOT permitted on either table (ADR-023 D8). This
 * migration does not create any DELETE-related infrastructure;
 * Slice B2 and B3 will expose only insert + supersede paths.
 */
export async function up(knex: Knex): Promise<void> {
  // --- rate_auth_restriction ------------------------------------------------
  //
  // Composite FK (season_id, contract_id) → rate_auth_season(id, contract_id)
  // reuses the UNIQUE(id, contract_id) target from ADR-022 D3.
  // PostgreSQL MATCH SIMPLE (default) skips the FK check when any
  // column in the composite is NULL, so:
  //   - season_id IS NULL: applies to all seasons (contract-wide or
  //     supplier-default scope).
  //   - contract_id IS NULL: supplier-default rule (no contract).
  //   - both non-null: full composite is enforced; cross-contract
  //     season references are rejected by the DB.

  await knex.raw(`
    CREATE TABLE rate_auth_restriction (
      id                 CHAR(26)     NOT NULL,
      tenant_id          CHAR(26)     NOT NULL,
      supplier_id        CHAR(26)     NOT NULL,
      canonical_hotel_id CHAR(26)     NOT NULL,
      rate_plan_id       CHAR(26),
      room_type_id       CHAR(26),
      contract_id        CHAR(26),
      season_id          CHAR(26),
      stay_date          DATE         NOT NULL,
      restriction_kind   VARCHAR(32)  NOT NULL,
      params             JSONB        NOT NULL DEFAULT '{}',
      effective_from     TIMESTAMPTZ  NOT NULL,
      effective_to       TIMESTAMPTZ,
      superseded_by_id   CHAR(26),
      created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),

      CONSTRAINT rate_auth_restriction_pk             PRIMARY KEY (id),
      CONSTRAINT rate_auth_restriction_tenant_fk      FOREIGN KEY (tenant_id)
                                                      REFERENCES core_tenant(id),
      CONSTRAINT rate_auth_restriction_supplier_fk    FOREIGN KEY (supplier_id)
                                                      REFERENCES supply_supplier(id),
      CONSTRAINT rate_auth_restriction_hotel_fk       FOREIGN KEY (canonical_hotel_id)
                                                      REFERENCES hotel_canonical(id),
      CONSTRAINT rate_auth_restriction_rate_plan_fk   FOREIGN KEY (rate_plan_id)
                                                      REFERENCES hotel_rate_plan(id),
      CONSTRAINT rate_auth_restriction_room_type_fk   FOREIGN KEY (room_type_id)
                                                      REFERENCES hotel_room_type(id),
      CONSTRAINT rate_auth_restriction_contract_fk    FOREIGN KEY (contract_id)
                                                      REFERENCES rate_auth_contract(id),
      CONSTRAINT rate_auth_restriction_season_fk      FOREIGN KEY (season_id, contract_id)
                                                      REFERENCES rate_auth_season(id, contract_id),
      CONSTRAINT rate_auth_restriction_superseded_fk  FOREIGN KEY (superseded_by_id)
                                                      REFERENCES rate_auth_restriction(id),
      CONSTRAINT rate_auth_restriction_kind_chk       CHECK (restriction_kind IN (
                                                        'STOP_SELL',
                                                        'CTA',
                                                        'CTD',
                                                        'MIN_LOS',
                                                        'MAX_LOS',
                                                        'ADVANCE_PURCHASE_MIN',
                                                        'ADVANCE_PURCHASE_MAX',
                                                        'RELEASE_HOURS',
                                                        'CUTOFF_HOURS'
                                                      )),
      CONSTRAINT rate_auth_restriction_effective_chk  CHECK (
                                                        effective_to IS NULL
                                                        OR effective_to >= effective_from
                                                      )
    )
  `);

  // Search-time evaluator filter: hotel + stay window scan. The
  // evaluator further narrows by rate_plan_id / room_type_id /
  // contract_id in application code per ADR-023 D4 most-specific-wins.
  await knex.raw(`
    CREATE INDEX rate_auth_restriction_lookup_idx
    ON rate_auth_restriction(tenant_id, supplier_id, canonical_hotel_id, stay_date)
  `);

  // Admin "list restrictions for contract" path; partial keeps the
  // index small for supplier-default rows where contract_id IS NULL.
  await knex.raw(`
    CREATE INDEX rate_auth_restriction_contract_idx
    ON rate_auth_restriction(contract_id)
    WHERE contract_id IS NOT NULL
  `);

  // --- rate_auth_cancellation_policy ----------------------------------------
  //
  // No season_id column on this table per ADR-023 D1: cancellation
  // policies in real paper contracts apply at the rate-plan level
  // across all seasons in the contract, not per season. A per-season
  // override, if ever needed, can be expressed as a narrow contract-
  // scoped row in a future revision.
  //
  // policy_version uniqueness per (tenant, supplier, hotel, rate_plan,
  // contract) scope (ADR-023 D5) is enforced by the service layer
  // using a serializable transaction with SELECT MAX FOR UPDATE,
  // following the ADR-022 D5 precedent for season non-overlap. No
  // DB-level unique index here — partial-unique with two nullable
  // columns adds index surface without extra correctness over the
  // service-layer guard.

  await knex.raw(`
    CREATE TABLE rate_auth_cancellation_policy (
      id                 CHAR(26)     NOT NULL,
      tenant_id          CHAR(26)     NOT NULL,
      supplier_id        CHAR(26)     NOT NULL,
      canonical_hotel_id CHAR(26)     NOT NULL,
      rate_plan_id       CHAR(26),
      contract_id        CHAR(26),
      policy_version     SMALLINT     NOT NULL,
      windows_jsonb      JSONB        NOT NULL,
      refundable         BOOLEAN      NOT NULL,
      effective_from     TIMESTAMPTZ  NOT NULL,
      effective_to       TIMESTAMPTZ,
      superseded_by_id   CHAR(26),
      created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),

      CONSTRAINT rate_auth_cancellation_policy_pk             PRIMARY KEY (id),
      CONSTRAINT rate_auth_cancellation_policy_tenant_fk      FOREIGN KEY (tenant_id)
                                                              REFERENCES core_tenant(id),
      CONSTRAINT rate_auth_cancellation_policy_supplier_fk    FOREIGN KEY (supplier_id)
                                                              REFERENCES supply_supplier(id),
      CONSTRAINT rate_auth_cancellation_policy_hotel_fk       FOREIGN KEY (canonical_hotel_id)
                                                              REFERENCES hotel_canonical(id),
      CONSTRAINT rate_auth_cancellation_policy_rate_plan_fk   FOREIGN KEY (rate_plan_id)
                                                              REFERENCES hotel_rate_plan(id),
      CONSTRAINT rate_auth_cancellation_policy_contract_fk    FOREIGN KEY (contract_id)
                                                              REFERENCES rate_auth_contract(id),
      CONSTRAINT rate_auth_cancellation_policy_superseded_fk  FOREIGN KEY (superseded_by_id)
                                                              REFERENCES rate_auth_cancellation_policy(id),
      CONSTRAINT rate_auth_cancellation_policy_version_chk    CHECK (policy_version >= 1),
      CONSTRAINT rate_auth_cancellation_policy_effective_chk  CHECK (
                                                                effective_to IS NULL
                                                                OR effective_to >= effective_from
                                                              )
    )
  `);

  // Resolver lookup: scan candidate rows by hotel and pick the
  // highest active policy_version in application code (ADR-023 D5).
  await knex.raw(`
    CREATE INDEX rate_auth_cancellation_policy_lookup_idx
    ON rate_auth_cancellation_policy(tenant_id, supplier_id, canonical_hotel_id, policy_version)
  `);

  // Admin "list policies for contract"; partial for supplier-default
  // rows where contract_id IS NULL.
  await knex.raw(`
    CREATE INDEX rate_auth_cancellation_policy_contract_idx
    ON rate_auth_cancellation_policy(contract_id)
    WHERE contract_id IS NOT NULL
  `);
}

export async function down(knex: Knex): Promise<void> {
  // Reverse creation order. No child tables reference these in
  // Phase B; future booking-time snapshot tables will, and their
  // own migrations will own their drop order.
  await knex.raw('DROP TABLE IF EXISTS rate_auth_cancellation_policy');
  await knex.raw('DROP TABLE IF EXISTS rate_auth_restriction');
}
