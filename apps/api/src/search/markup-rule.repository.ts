import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from '@bb/db';
import type {
  AccountType,
  MarkupRuleScope,
  MarkupRuleSnapshot,
} from '@bb/domain';
import { PG_POOL } from '../database/database.module';

interface MarkupRuleRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly scope: MarkupRuleScope;
  readonly account_id: string | null;
  readonly supplier_hotel_id: string | null;
  readonly account_type: AccountType | null;
  readonly markup_kind: string;
  readonly percent_value: string | null;
  readonly priority: number;
}

/**
 * Postgres-backed read of `pricing_markup_rule` filtered to the
 * candidate set the evaluator needs for one search request.
 *
 * We over-fetch deliberately: any rule that COULD apply to this
 * (tenant, account, accountType, supplierHotelIds) tuple is loaded,
 * and the in-memory evaluator does the precedence picking. This
 * keeps the SQL stable and the precedence logic single-sourced in
 * `@bb/pricing`.
 *
 * Time-bound filtering (`valid_from`, `valid_to`) happens here so a
 * rule that has expired never reaches the evaluator.
 *
 * Unknown `markup_kind` values pass through to the evaluator, which
 * skips them. This keeps adding a new kind additive without a
 * synchronized rollout between the migration, the SQL, and the
 * evaluator.
 */
@Injectable()
export class PgMarkupRuleRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async findApplicable(args: {
    readonly tenantId: string;
    readonly accountId: string;
    readonly accountType: AccountType;
    readonly supplierHotelIds: ReadonlyArray<string>;
  }): Promise<ReadonlyArray<MarkupRuleSnapshot>> {
    const { tenantId, accountId, accountType, supplierHotelIds } = args;

    const { rows } = await this.pool.query<MarkupRuleRow>(
      `
      SELECT id, tenant_id, scope, account_id, supplier_hotel_id,
             account_type, markup_kind, percent_value, priority
        FROM pricing_markup_rule
       WHERE tenant_id = $1
         AND status = 'ACTIVE'
         AND (valid_from IS NULL OR valid_from <= now())
         AND (valid_to IS NULL OR valid_to > now())
         AND (
           (scope = 'ACCOUNT' AND account_id = $2)
           OR
           (scope = 'HOTEL' AND supplier_hotel_id = ANY($3::text[]))
           OR
           (scope = 'CHANNEL' AND account_type = $4)
         )
      `,
      [tenantId, accountId, supplierHotelIds as readonly string[], accountType],
    );

    return rows.map(toSnapshot).filter((r): r is MarkupRuleSnapshot => r !== null);
  }
}

function toSnapshot(row: MarkupRuleRow): MarkupRuleSnapshot | null {
  // Only PERCENT is supported in the evaluator today. Future kinds
  // get their own loader once their columns exist.
  if (row.markup_kind !== 'PERCENT' || row.percent_value === null) return null;
  const base = {
    id: row.id,
    tenantId: row.tenant_id,
    scope: row.scope,
    markupKind: 'PERCENT' as const,
    percentValue: row.percent_value,
    priority: row.priority,
  };
  switch (row.scope) {
    case 'ACCOUNT':
      return row.account_id !== null
        ? { ...base, accountId: row.account_id }
        : null;
    case 'HOTEL':
      return row.supplier_hotel_id !== null
        ? { ...base, supplierHotelId: row.supplier_hotel_id }
        : null;
    case 'CHANNEL':
      return row.account_type !== null
        ? { ...base, accountType: row.account_type }
        : null;
  }
}
