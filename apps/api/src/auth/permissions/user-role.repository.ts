import { Injectable } from '@nestjs/common';
import type { Queryable } from '../../database/queryable';
import type { Role } from './permissions';

/**
 * Read/write surface for `user_role` (ADR-026 Slice E3-A).
 *
 * Append-only. A revoke writes timestamps and stops the row from
 * appearing in `findActiveRolesForUser`. Re-grant after revoke
 * inserts a new row.
 *
 *   - `findActiveRolesForUser` — primary read, used by the
 *                                 permission resolver on every
 *                                 permission check.
 *
 *   - `insert`                  — write-side, used by the future
 *                                 role-grant service (E2-B / E10).
 *                                 Exposed here so a single repository
 *                                 owns the table; not invoked from
 *                                 any code shipping in this slice.
 *
 *   - `revoke`                  — same.
 *
 * The class-coherence invariant (operator role on OPERATOR user;
 * agency role on AGENCY user) is enforced at the future write-side
 * service, not in this repository — repositories translate typed
 * input to rows; cross-table validation lives a layer up.
 */
export interface UserRoleRecord {
  readonly id: string;
  readonly userId: string;
  readonly role: Role;
  readonly grantedBy: string | null;
  readonly grantedAt: string;
  readonly revokedBy: string | null;
  readonly revokedAt: string | null;
}

interface UserRoleDbRow {
  readonly id: string;
  readonly user_id: string;
  readonly role: string;
  readonly granted_by: string | null;
  readonly granted_at: Date | string;
  readonly revoked_by: string | null;
  readonly revoked_at: Date | string | null;
}

function toIso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function rowToRecord(row: UserRoleDbRow): UserRoleRecord {
  return {
    id: row.id,
    userId: row.user_id,
    role: row.role as Role,
    grantedBy: row.granted_by,
    grantedAt: toIso(row.granted_at),
    revokedBy: row.revoked_by,
    revokedAt: row.revoked_at === null ? null : toIso(row.revoked_at),
  };
}

export interface InsertUserRoleInput {
  readonly id: string;
  readonly userId: string;
  readonly role: Role;
  /** NULL only for the bootstrap platform_admin self-grant. */
  readonly grantedBy: string | null;
}

@Injectable()
export class UserRoleRepository {
  /**
   * Returns the set of active role names for `userId`. Order is not
   * meaningful; the resolver expands roles to permissions via the
   * static catalogue.
   */
  async findActiveRolesForUser(
    q: Queryable,
    userId: string,
  ): Promise<readonly Role[]> {
    const sql = `
      SELECT role
        FROM user_role
       WHERE user_id = $1
         AND revoked_at IS NULL
    `;
    const { rows } = await q.query<{ role: string }>(sql, [userId]);
    return rows.map((r) => r.role as Role);
  }

  /** Returns full row records for ops review / audit views (E10). */
  async findAllForUser(
    q: Queryable,
    userId: string,
  ): Promise<readonly UserRoleRecord[]> {
    const sql = `
      SELECT id, user_id, role, granted_by, granted_at,
             revoked_by, revoked_at
        FROM user_role
       WHERE user_id = $1
       ORDER BY granted_at DESC
    `;
    const { rows } = await q.query<UserRoleDbRow>(sql, [userId]);
    return rows.map(rowToRecord);
  }

  /**
   * Inserts a new active grant. The partial unique index
   * `user_role_active_uq` guarantees at most one active grant per
   * (user_id, role); a duplicate insert surfaces as a Postgres
   * unique_violation (SQLSTATE 23505) which the future write-side
   * service interprets as "already granted."
   */
  async insert(q: Queryable, input: InsertUserRoleInput): Promise<{ id: string }> {
    const sql = `
      INSERT INTO user_role (id, user_id, role, granted_by)
      VALUES ($1, $2, $3, $4)
      RETURNING id
    `;
    const values: unknown[] = [
      input.id,
      input.userId,
      input.role,
      input.grantedBy,
    ];
    const { rows } = await q.query<{ id: string }>(sql, values);
    return { id: rows[0]!.id };
  }

  /**
   * Marks the active grant for (userId, role) as revoked. Idempotent
   * at the SQL level — a second revoke on an already-revoked grant
   * matches zero rows (the WHERE filter excludes it). Returns the
   * number of rows updated, so the caller can distinguish "revoked
   * just now" from "no active grant existed."
   */
  async revoke(
    q: Queryable,
    args: { userId: string; role: Role; revokedBy: string },
  ): Promise<{ rowsUpdated: number }> {
    const sql = `
      UPDATE user_role
         SET revoked_at = now(),
             revoked_by = $3
       WHERE user_id = $1
         AND role    = $2
         AND revoked_at IS NULL
    `;
    const { rowCount } = await q.query(sql, [
      args.userId,
      args.role,
      args.revokedBy,
    ]);
    return { rowsUpdated: rowCount ?? 0 };
  }
}
