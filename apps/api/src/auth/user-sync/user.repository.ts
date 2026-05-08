import { Injectable } from '@nestjs/common';
import type { Queryable } from '../../database/queryable';

/**
 * Read/write surface for `core_user` (Slice E2-A).
 *
 *   - `findByAuth0Sub` — primary lookup at the request boundary.
 *   - `insertJit`      — bootstrap-only JIT creation. Locked rule:
 *                         the caller (`UserSyncService`) only invokes
 *                         this when AUTH0_BOOTSTRAP_MODE=true. Outside
 *                         bootstrap, missing-user is a hard fail.
 *   - `touchLogin`     — updates `updated_at` on a successful auth.
 *
 * Admin-driven provisioning (Management API → Auth0 user → DB row) is
 * E2-B and lives in a different service; this repository does not
 * expose a `createForInvitation` method in this slice.
 */

export type UserClass = 'OPERATOR' | 'AGENCY';
export type UserStatus = 'ACTIVE' | 'DEACTIVATED';

export interface CoreUserRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly auth0Sub: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly userClass: UserClass;
  readonly status: UserStatus;
}

interface CoreUserDbRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly auth0_sub: string;
  readonly email: string;
  readonly display_name: string | null;
  readonly user_class: string;
  readonly status: string;
}

function rowToRecord(row: CoreUserDbRow): CoreUserRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    auth0Sub: row.auth0_sub,
    email: row.email,
    displayName: row.display_name,
    userClass: row.user_class as UserClass,
    status: row.status as UserStatus,
  };
}

export interface JitInsertInput {
  readonly id: string;
  readonly tenantId: string;
  readonly auth0Sub: string;
  readonly email: string;
  readonly displayName?: string;
  readonly userClass: UserClass;
}

@Injectable()
export class CoreUserRepository {
  async findByAuth0Sub(
    q: Queryable,
    auth0Sub: string,
  ): Promise<CoreUserRecord | undefined> {
    const sql = `
      SELECT id, tenant_id, auth0_sub, email, display_name,
             user_class, status
        FROM core_user
       WHERE auth0_sub = $1
    `;
    const { rows } = await q.query<CoreUserDbRow>(sql, [auth0Sub]);
    return rows.length > 0 ? rowToRecord(rows[0]!) : undefined;
  }

  /**
   * Bootstrap-only JIT insert. The caller is responsible for ensuring
   * AUTH0_BOOTSTRAP_MODE is set; this repo does not re-check the
   * config (one source of truth lives in `UserSyncService`).
   */
  async insertJit(
    q: Queryable,
    input: JitInsertInput,
  ): Promise<CoreUserRecord> {
    const sql = `
      INSERT INTO core_user (
        id, tenant_id, auth0_sub, email, display_name,
        user_class, status
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE')
      RETURNING id, tenant_id, auth0_sub, email, display_name,
                user_class, status
    `;
    const values: unknown[] = [
      input.id,
      input.tenantId,
      input.auth0Sub,
      input.email,
      input.displayName ?? null,
      input.userClass,
    ];
    const { rows } = await q.query<CoreUserDbRow>(sql, values);
    return rowToRecord(rows[0]!);
  }

  /**
   * Lightweight `updated_at` touch on a verified login. Does not
   * mutate any business field; useful for activity reporting.
   */
  async touchLogin(q: Queryable, userId: string): Promise<void> {
    await q.query(
      `UPDATE core_user SET updated_at = now() WHERE id = $1`,
      [userId],
    );
  }
}
