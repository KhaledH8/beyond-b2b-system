import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from '@bb/db';
import type { AccountType, PromotionKind, PromotionTag } from '@bb/domain';
import { PG_POOL } from '../database/database.module';

interface PromotionRow {
  readonly supplier_hotel_id: string;
  readonly kind: PromotionKind;
  readonly priority: number;
}

/**
 * Postgres-backed read of `merchandising_promotion`.
 *
 * Returns one tag per supplier hotel — when multiple promotions
 * match, the highest-priority row wins (with `kind` order as the
 * tie-break: PROMOTED > FEATURED > RECOMMENDED). Channel-specific
 * promotions outrank "any channel" promotions of the same priority.
 *
 * Promotions are advisory only. The search service attaches the
 * matching tag to a result; the underlying selling price and
 * price-sort order are set by the pricing evaluator and unaffected.
 */
@Injectable()
export class PgPromotionRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async findApplicable(args: {
    readonly tenantId: string;
    readonly accountType: AccountType;
    readonly supplierHotelIds: ReadonlyArray<string>;
  }): Promise<ReadonlyMap<string, PromotionTag>> {
    if (args.supplierHotelIds.length === 0) {
      return new Map<string, PromotionTag>();
    }

    const { rows } = await this.pool.query<PromotionRow>(
      `
      SELECT DISTINCT ON (supplier_hotel_id)
             supplier_hotel_id, kind, priority
        FROM merchandising_promotion
       WHERE tenant_id = $1
         AND status = 'ACTIVE'
         AND supplier_hotel_id = ANY($2::text[])
         AND (account_type IS NULL OR account_type = $3)
         AND (valid_from IS NULL OR valid_from <= now())
         AND (valid_to IS NULL OR valid_to > now())
       ORDER BY supplier_hotel_id,
                priority DESC,
                CASE
                  WHEN account_type IS NOT NULL THEN 0
                  ELSE 1
                END,
                CASE kind
                  WHEN 'PROMOTED' THEN 0
                  WHEN 'FEATURED' THEN 1
                  WHEN 'RECOMMENDED' THEN 2
                  ELSE 3
                END
      `,
      [
        args.tenantId,
        args.supplierHotelIds as readonly string[],
        args.accountType,
      ],
    );

    const out = new Map<string, PromotionTag>();
    for (const row of rows) {
      out.set(row.supplier_hotel_id, {
        kind: row.kind,
        priority: row.priority,
      });
    }
    return out;
  }
}
