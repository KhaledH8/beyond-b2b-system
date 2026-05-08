import { Injectable } from '@nestjs/common';
import type { Queryable } from '../../database/queryable';

/**
 * Read/write surface for `core_user` (Slices E2-A + E2-B).
 *
 *   - `findByAuth0Sub`    — primary lookup at the request boundary.
 *   - `findById`          — used by webhook handlers and the bootstrap
 *                            script after they resolve the user via
 *                            other means.
 *   - `insertJit`         — bootstrap-only JIT creation (E2-A locked
 *                            rule: caller checks
 *                            AUTH0_BOOTSTRAP_MODE=true).
 *   - `insertProvisioned` — admin-driven provisioning (E2-B). Same
 *                            row shape as `insertJit`; the caller
 *                            (UserProvisioningService) is responsible
 *                            for already having created the Auth0
 *                            user so `auth0_sub` is real.
 *   - `updateProfile`     — webhook-driven email / display_name
 *                            refresh on Auth0-side updates.
 *   - `setStatus`         — webhook-driven user delete or block flips
 *                            `status`.
 *   - `touchLogin`        — updates `updated_at` on a successful auth.
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

export type ProvisionedInsertInput = JitInsertInput;

export interface UpdateProfileInput {
  readonly email?: string;
  readonly displayName?: string | null;
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

  async findById(
    q: Queryable,
    id: string,
  ): Promise<CoreUserRecord | undefined> {
    const sql = `
      SELECT id, tenant_id, auth0_sub, email, display_name,
             user_class, status
        FROM core_user
       WHERE id = $1
    `;
    const { rows } = await q.query<CoreUserDbRow>(sql, [id]);
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
    return this.insertCore(q, input);
  }

  /**
   * Admin-driven provisioning insert (E2-B). The caller has already
   * created the Auth0 user via the Management API and is therefore
   * authoritative on `auth0_sub`. The DB transaction this runs in is
   * the same one that inserts the role grant and (for AGENCY users)
   * the membership row.
   */
  async insertProvisioned(
    q: Queryable,
    input: ProvisionedInsertInput,
  ): Promise<CoreUserRecord> {
    return this.insertCore(q, input);
  }

  /**
   * Apply Auth0 user-updated webhook deltas. Only the fields included
   * in `patch` are touched. `displayName: null` clears the column;
   * omitting the field leaves it alone. Returns true iff the row
   * existed and was updated; false signals a webhook for a user we
   * never provisioned (which is normal in early bootstrap and should
   * just be logged at the call site, not error).
   */
  async updateProfile(
    q: Queryable,
    auth0Sub: string,
    patch: UpdateProfileInput,
  ): Promise<boolean> {
    const sets: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    if (patch.email !== undefined) {
      sets.push(`email = $${i++}`);
      values.push(patch.email);
    }
    if (patch.displayName !== undefined) {
      sets.push(`display_name = $${i++}`);
      values.push(patch.displayName);
    }
    if (sets.length === 0) return false;
    sets.push(`updated_at = now()`);
    values.push(auth0Sub);
    const sql = `
      UPDATE core_user
         SET ${sets.join(', ')}
       WHERE auth0_sub = $${i}
    `;
    const { rowCount } = await q.query(sql, values);
    return (rowCount ?? 0) > 0;
  }

  /**
   * Webhook-driven status flip. `DEACTIVATED` is the path used when
   * Auth0 reports a user delete or a "blocked" toggle.
   */
  async setStatus(
    q: Queryable,
    auth0Sub: string,
    status: UserStatus,
  ): Promise<boolean> {
    const sql = `
      UPDATE core_user
         SET status = $1,
             updated_at = now()
       WHERE auth0_sub = $2
    `;
    const { rowCount } = await q.query(sql, [status, auth0Sub]);
    return (rowCount ?? 0) > 0;
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

  private async insertCore(
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
}
