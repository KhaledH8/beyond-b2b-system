import type { Knex } from 'knex';

/**
 * `merchandising_promotion` — first-slice promoted/recommended hotel
 * tags surfaced on search results.
 *
 * CLAUDE.md invariant: merchandising MUST NOT mutate priced rates.
 * This table holds purely decorative flags. The search service
 * attaches matching `kind` to a result; the underlying selling price
 * and price-sort order come from the pricing evaluator and are
 * unaffected by promotion state.
 *
 * Scope:
 *   - `supplier_hotel_id` is required: a promotion always points at
 *     one hotel. Once canonical mapping lands (`packages/mapping/`),
 *     a sister `canonical_hotel_id` column will be added so a single
 *     promotion can cover the same real-world hotel across multiple
 *     supplier sources.
 *   - `account_type` is optional. NULL means "any channel"; a value
 *     restricts the promotion to the matching channel
 *     (B2C / AGENCY / SUBSCRIBER / CORPORATE).
 *
 * Time bounds and `status` mirror `pricing_markup_rule` — same TTL
 * pattern, same sweeper-friendly partial indexes.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE merchandising_promotion (
      id                  CHAR(26)     NOT NULL,
      tenant_id           CHAR(26)     NOT NULL,
      supplier_hotel_id   CHAR(26)     NOT NULL,
      kind                VARCHAR(32)  NOT NULL,
      priority            INTEGER      NOT NULL DEFAULT 0,
      account_type        VARCHAR(32),
      valid_from          TIMESTAMPTZ,
      valid_to            TIMESTAMPTZ,
      status              VARCHAR(32)  NOT NULL DEFAULT 'ACTIVE',
      created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
      updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),

      CONSTRAINT merchandising_promotion_pk          PRIMARY KEY (id),
      CONSTRAINT merchandising_promotion_tenant_fk   FOREIGN KEY (tenant_id)
                                                     REFERENCES core_tenant(id),
      CONSTRAINT merchandising_promotion_hotel_fk    FOREIGN KEY (supplier_hotel_id)
                                                     REFERENCES hotel_supplier(id),
      CONSTRAINT merchandising_promotion_kind_chk    CHECK (
        kind IN ('PROMOTED', 'RECOMMENDED', 'FEATURED')
      ),
      CONSTRAINT merchandising_promotion_status_chk  CHECK (status IN ('ACTIVE', 'INACTIVE')),
      CONSTRAINT merchandising_promotion_acct_type_chk CHECK (
        account_type IS NULL
          OR account_type IN ('B2C', 'AGENCY', 'SUBSCRIBER', 'CORPORATE')
      ),
      CONSTRAINT merchandising_promotion_validity_chk CHECK (
        valid_from IS NULL OR valid_to IS NULL OR valid_to > valid_from
      )
    )
  `);

  await knex.raw(`
    CREATE INDEX merchandising_promotion_hotel_idx
    ON merchandising_promotion(tenant_id, supplier_hotel_id)
    WHERE status = 'ACTIVE'
  `);

  await knex.raw(`
    CREATE INDEX merchandising_promotion_channel_idx
    ON merchandising_promotion(tenant_id, account_type)
    WHERE account_type IS NOT NULL AND status = 'ACTIVE'
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP TABLE IF EXISTS merchandising_promotion');
}
