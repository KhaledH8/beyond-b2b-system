import { Injectable } from '@nestjs/common';
import type { Queryable } from '../../database/queryable';

/**
 * Read/write surface for `user_account_membership` (ADR-026 Slice E3-A).
 *
 * The V1 lock is single-account-per-user (D11). The schema-level
 * UNIQUE (user_id) constraint is the source of truth — a second
 * insert for the same user surfaces as a Postgres unique_violation,
 * which the future provisioning service translates to a clear error.
 *
 *   - `findActiveByUser` — primary lookup; returns the user's single
 *                          ACTIVE membership if present.
 *
 *   - `insert`           — write-side; not invoked in this slice.
 *
 * The class-coherence invariant (OPERATOR users have zero
 * memberships; AGENCY users have one) is application-enforced at the
 * future provisioning boundary — not by a SQL trigger.
 */

export type MembershipStatus = 'ACTIVE' | 'INACTIVE';

export interface UserAccountMembershipRecord {
  readonly id: string;
  readonly userId: string;
  readonly accountId: string;
  readonly status: MembershipStatus;
}

interface MembershipDbRow {
  readonly id: string;
  readonly user_id: string;
  readonly account_id: string;
  readonly status: string;
}

function rowToRecord(row: MembershipDbRow): UserAccountMembershipRecord {
  return {
    id: row.id,
    userId: row.user_id,
    accountId: row.account_id,
    status: row.status as MembershipStatus,
  };
}

export interface InsertMembershipInput {
  readonly id: string;
  readonly userId: string;
  readonly accountId: string;
}

@Injectable()
export class UserAccountMembershipRepository {
  /**
   * Returns the user's ACTIVE membership row if one exists. The
   * UNIQUE (user_id) constraint guarantees at most one row total per
   * user; this method additionally filters to ACTIVE so that a future
   * status flip to INACTIVE surfaces as "no membership" without
   * needing a separate revoke flow.
   */
  async findActiveByUser(
    q: Queryable,
    userId: string,
  ): Promise<UserAccountMembershipRecord | undefined> {
    const sql = `
      SELECT id, user_id, account_id, status
        FROM user_account_membership
       WHERE user_id = $1
         AND status = 'ACTIVE'
    `;
    const { rows } = await q.query<MembershipDbRow>(sql, [userId]);
    return rows.length > 0 ? rowToRecord(rows[0]!) : undefined;
  }

  /**
   * Inserts a new membership. The schema's UNIQUE (user_id)
   * constraint enforces single-account-per-user; a second insert for
   * the same user surfaces as unique_violation (SQLSTATE 23505).
   */
  async insert(
    q: Queryable,
    input: InsertMembershipInput,
  ): Promise<{ id: string }> {
    const sql = `
      INSERT INTO user_account_membership (id, user_id, account_id)
      VALUES ($1, $2, $3)
      RETURNING id
    `;
    const { rows } = await q.query<{ id: string }>(sql, [
      input.id,
      input.userId,
      input.accountId,
    ]);
    return { id: rows[0]!.id };
  }
}
