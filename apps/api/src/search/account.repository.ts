import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool } from '@bb/db';
import type { AccountType } from '@bb/domain';
import { PG_POOL } from '../database/database.module';

interface AccountRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly account_type: AccountType;
}

/**
 * Lightweight account lookup for the search service.
 *
 * The search request carries `accountId`; the service resolves it to
 * `(tenantId, accountType)` here, then drives pricing + merchandising
 * with that context. We deliberately do NOT load the full `Account`
 * domain object — pricing / merchandising only need the type and
 * tenant scoping.
 *
 * The status filter blocks SUSPENDED / CLOSED accounts from
 * triggering searches at all; the controller surfaces this as 404.
 */
@Injectable()
export class PgAccountRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async resolveActive(accountId: string): Promise<{
    accountId: string;
    tenantId: string;
    accountType: AccountType;
  }> {
    const { rows } = await this.pool.query<AccountRow>(
      `SELECT id, tenant_id, account_type
         FROM core_account
        WHERE id = $1
          AND status = 'ACTIVE'
        LIMIT 1`,
      [accountId],
    );
    const row = rows[0];
    if (!row) {
      throw new NotFoundException(
        `No active core_account row for id=${accountId}`,
      );
    }
    return {
      accountId: row.id,
      tenantId: row.tenant_id,
      accountType: row.account_type,
    };
  }
}
