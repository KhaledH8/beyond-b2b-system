import type { Knex } from 'knex';

/**
 * `pricing_markup_rule` — first-slice markup storage for the sourced
 * pricing path (ADR-004 / ADR-021).
 *
 * Three precedence scopes, exactly one of which a row binds to:
 *   - ACCOUNT  — applies when `account_id` matches the request's
 *                account. Highest precedence.
 *   - HOTEL    — applies when `supplier_hotel_id` matches the
 *                offer's hotel.
 *   - CHANNEL  — applies when `account_type` matches the request's
 *                account type (B2C / AGENCY / SUBSCRIBER / CORPORATE).
 *                Lowest precedence; the channel default.
 *
 * The discriminated-union shape is enforced at the row level by
 * `pricing_markup_rule_scope_chk` so a single rule cannot
 * accidentally bind two scopes (e.g. account + channel).
 *
 * `markup_kind = 'PERCENT'` is the only kind shipped here — fixed and
 * market-adjusted markups (ADR-015) land in later slices and add
 * their own kind values + columns. Adding a kind is additive; rows
 * with unknown kinds are skipped by the evaluator.
 *
 * Time bounds (`valid_from`, `valid_to`) are nullable. NULL means
 * "always" on that end of the range. The evaluator filters at read
 * time; `valid_to` is also indexed so deactivation sweeps stay fast.
 *
 * `priority` breaks ties within a scope: when two rules of the same
 * scope match, the higher `priority` wins. Across scopes, scope
 * precedence (ACCOUNT > HOTEL > CHANNEL) wins regardless of priority.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE pricing_markup_rule (
      id                  CHAR(26)     NOT NULL,
      tenant_id           CHAR(26)     NOT NULL,

      scope               VARCHAR(32)  NOT NULL,
      account_id          CHAR(26),
      supplier_hotel_id   CHAR(26),
      account_type        VARCHAR(32),

      markup_kind         VARCHAR(32)  NOT NULL,
      percent_value       NUMERIC(7,4),

      priority            INTEGER      NOT NULL DEFAULT 0,
      valid_from          TIMESTAMPTZ,
      valid_to            TIMESTAMPTZ,
      status              VARCHAR(32)  NOT NULL DEFAULT 'ACTIVE',
      created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
      updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),

      CONSTRAINT pricing_markup_rule_pk           PRIMARY KEY (id),
      CONSTRAINT pricing_markup_rule_tenant_fk    FOREIGN KEY (tenant_id)
                                                  REFERENCES core_tenant(id),
      CONSTRAINT pricing_markup_rule_account_fk   FOREIGN KEY (account_id)
                                                  REFERENCES core_account(id),
      CONSTRAINT pricing_markup_rule_hotel_fk     FOREIGN KEY (supplier_hotel_id)
                                                  REFERENCES hotel_supplier(id),
      CONSTRAINT pricing_markup_rule_scope_chk    CHECK (
        (scope = 'ACCOUNT' AND account_id IS NOT NULL
                            AND supplier_hotel_id IS NULL
                            AND account_type IS NULL)
        OR
        (scope = 'HOTEL'   AND account_id IS NULL
                            AND supplier_hotel_id IS NOT NULL
                            AND account_type IS NULL)
        OR
        (scope = 'CHANNEL' AND account_id IS NULL
                            AND supplier_hotel_id IS NULL
                            AND account_type IS NOT NULL)
      ),
      CONSTRAINT pricing_markup_rule_kind_chk     CHECK (markup_kind IN ('PERCENT')),
      CONSTRAINT pricing_markup_rule_percent_chk  CHECK (
        markup_kind <> 'PERCENT' OR (percent_value IS NOT NULL AND percent_value >= 0)
      ),
      CONSTRAINT pricing_markup_rule_acct_type_chk CHECK (
        account_type IS NULL
          OR account_type IN ('B2C', 'AGENCY', 'SUBSCRIBER', 'CORPORATE')
      ),
      CONSTRAINT pricing_markup_rule_status_chk    CHECK (status IN ('ACTIVE', 'INACTIVE')),
      CONSTRAINT pricing_markup_rule_validity_chk  CHECK (
        valid_from IS NULL OR valid_to IS NULL OR valid_to > valid_from
      )
    )
  `);

  // Lookup path used by the search service: rules for one tenant filtered
  // down to the small set whose scope key matches the request.
  await knex.raw(`
    CREATE INDEX pricing_markup_rule_lookup_idx
    ON pricing_markup_rule(tenant_id, scope, status)
    WHERE status = 'ACTIVE'
  `);

  await knex.raw(`
    CREATE INDEX pricing_markup_rule_account_idx
    ON pricing_markup_rule(tenant_id, account_id)
    WHERE account_id IS NOT NULL AND status = 'ACTIVE'
  `);

  await knex.raw(`
    CREATE INDEX pricing_markup_rule_hotel_idx
    ON pricing_markup_rule(tenant_id, supplier_hotel_id)
    WHERE supplier_hotel_id IS NOT NULL AND status = 'ACTIVE'
  `);

  await knex.raw(`
    CREATE INDEX pricing_markup_rule_channel_idx
    ON pricing_markup_rule(tenant_id, account_type)
    WHERE account_type IS NOT NULL AND status = 'ACTIVE'
  `);

  // TTL sweeper hot-path: find rules whose `valid_to` has passed.
  await knex.raw(`
    CREATE INDEX pricing_markup_rule_valid_to_idx
    ON pricing_markup_rule(valid_to)
    WHERE valid_to IS NOT NULL AND status = 'ACTIVE'
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP TABLE IF EXISTS pricing_markup_rule');
}
