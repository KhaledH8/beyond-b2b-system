import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from '@bb/db';
import { PG_POOL } from '../database/database.module';

/**
 * Row shape returned by the agency selector query. Mirrors the public
 * service result — no internal-only columns are SELECTed.
 */
export interface AgencySummaryRow {
  readonly id: string;
  readonly name: string;
  readonly status: string;
}

export interface ListAgenciesQuery {
  /** The caller's tenant. Hard-scopes the lookup; cross-tenant leakage is impossible. */
  readonly tenantId: string;
  /** Trimmed search string. Empty string means "no filter". */
  readonly q: string;
  /** Clamped to the service-level cap before reaching the repo. */
  readonly limit: number;
}

/**
 * Read-only repository for the operator agency selector
 * (`GET /admin/agencies`). The query is tenant-scoped, filters to
 * `account_type = 'AGENCY'` + `status = 'ACTIVE'`, and supports a
 * single optional `q` parameter that matches the name (case-insensitive
 * substring) or the ULID (case-insensitive prefix).
 *
 * Parameterised throughout — no string interpolation. The current
 * `core_account_tenant_idx` btree covers the tenant scope; for higher
 * cardinality tenants a composite `(tenant_id, account_type, status, name)`
 * index can be added later without changing this SQL.
 */
@Injectable()
export class AgencySelectorRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async listActiveAgencies(
    input: ListAgenciesQuery,
  ): Promise<AgencySummaryRow[]> {
    const sql = `
      SELECT id, name, status
        FROM core_account
       WHERE tenant_id     = $1
         AND account_type  = 'AGENCY'
         AND status        = 'ACTIVE'
         AND (
              $2::text = ''
           OR name ILIKE '%' || $2::text || '%'
           OR id   ILIKE        $2::text || '%'
         )
       ORDER BY name ASC, id ASC
       LIMIT $3
    `;
    const { rows } = await this.pool.query<AgencySummaryRow>(sql, [
      input.tenantId,
      input.q,
      input.limit,
    ]);
    return rows;
  }
}
