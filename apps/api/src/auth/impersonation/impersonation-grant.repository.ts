import { Injectable } from '@nestjs/common';
import type { Queryable } from '../../database/queryable';

export interface ImpersonationGrantRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly targetAccountId: string;
  readonly reasonText: string;
  readonly ticketRef: string;
  readonly scope: 'READ_ONLY';
  readonly startedAt: string;
  readonly expiresAt: string;
  readonly endedAt: string | null;
  readonly endedReason: 'OPERATOR_ENDED' | 'EXPIRED' | 'ADMIN_REVOKED' | null;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

interface ImpersonationGrantDbRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly actor_user_id: string;
  readonly target_account_id: string;
  readonly reason_text: string;
  readonly ticket_ref: string;
  readonly scope: string;
  readonly started_at: Date | string;
  readonly expires_at: Date | string;
  readonly ended_at: Date | string | null;
  readonly ended_reason: string | null;
  readonly ip_address: string | null;
  readonly user_agent: string | null;
}

function toIso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function rowToRecord(row: ImpersonationGrantDbRow): ImpersonationGrantRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    actorUserId: row.actor_user_id,
    targetAccountId: row.target_account_id,
    reasonText: row.reason_text,
    ticketRef: row.ticket_ref,
    scope: row.scope as 'READ_ONLY',
    startedAt: toIso(row.started_at),
    expiresAt: toIso(row.expires_at),
    endedAt: row.ended_at === null ? null : toIso(row.ended_at),
    endedReason: row.ended_reason as ImpersonationGrantRecord['endedReason'],
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
  };
}

export interface InsertGrantInput {
  readonly id: string;
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly targetAccountId: string;
  readonly reasonText: string;
  readonly ticketRef: string;
  readonly expiresAt: Date;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

const SELECT_COLS = `
  id, tenant_id, actor_user_id, target_account_id,
  reason_text, ticket_ref, scope,
  started_at, expires_at, ended_at, ended_reason,
  ip_address, user_agent
`;

@Injectable()
export class ImpersonationGrantRepository {
  /**
   * Returns the active (un-ended AND not yet expired) grant for the
   * actor. This is the hot-path resolver query run on every OPERATOR
   * request. AGENCY users do not trigger this lookup.
   */
  async findActiveByActor(
    q: Queryable,
    actorUserId: string,
  ): Promise<ImpersonationGrantRecord | null> {
    const sql = `
      SELECT ${SELECT_COLS}
        FROM impersonation_grant
       WHERE actor_user_id = $1
         AND ended_at IS NULL
         AND expires_at > now()
       LIMIT 1
    `;
    const { rows } = await q.query<ImpersonationGrantDbRow>(sql, [actorUserId]);
    return rows[0] ? rowToRecord(rows[0]) : null;
  }

  /**
   * Returns any un-ended grant (active OR past TTL but not yet
   * explicitly ended). Used by startImpersonation to detect stale
   * expired grants before the INSERT; the partial unique index
   * `impersonation_grant_actor_active_uq` covers `ended_at IS NULL`
   * and would reject a new INSERT while an expired but un-ended row
   * still exists.
   */
  async findUnendedByActor(
    q: Queryable,
    actorUserId: string,
  ): Promise<ImpersonationGrantRecord | null> {
    const sql = `
      SELECT ${SELECT_COLS}
        FROM impersonation_grant
       WHERE actor_user_id = $1
         AND ended_at IS NULL
       LIMIT 1
    `;
    const { rows } = await q.query<ImpersonationGrantDbRow>(sql, [actorUserId]);
    return rows[0] ? rowToRecord(rows[0]) : null;
  }

  /**
   * Inserts a new grant row and returns the full record. Caller must
   * be inside a transaction; the IMPERSONATION_STARTED audit event is
   * emitted in the same transaction via AuditService.emitInTransaction.
   */
  async insert(
    q: Queryable,
    input: InsertGrantInput,
  ): Promise<ImpersonationGrantRecord> {
    const sql = `
      INSERT INTO impersonation_grant (
        id, tenant_id, actor_user_id, target_account_id,
        reason_text, ticket_ref, scope,
        expires_at, ip_address, user_agent
      ) VALUES ($1, $2, $3, $4, $5, $6, 'READ_ONLY', $7, $8::inet, $9)
      RETURNING ${SELECT_COLS}
    `;
    const values: unknown[] = [
      input.id,
      input.tenantId,
      input.actorUserId,
      input.targetAccountId,
      input.reasonText,
      input.ticketRef,
      input.expiresAt,
      input.ipAddress,
      input.userAgent,
    ];
    const { rows } = await q.query<ImpersonationGrantDbRow>(sql, values);
    return rowToRecord(rows[0]!);
  }

  /**
   * Ends the actor's current un-ended grant. Idempotent: if no
   * un-ended grant exists, returns rowsUpdated=0 and grantId=null.
   *
   * Caller is responsible for emitting the IMPERSONATION_ENDED audit
   * event in the same transaction (or skipping it on no-op).
   */
  async end(
    q: Queryable,
    args: {
      actorUserId: string;
      endedReason: 'OPERATOR_ENDED' | 'EXPIRED' | 'ADMIN_REVOKED';
    },
  ): Promise<{ rowsUpdated: number; grantId: string | null }> {
    const sql = `
      UPDATE impersonation_grant
         SET ended_at     = now(),
             ended_reason = $2
       WHERE actor_user_id = $1
         AND ended_at IS NULL
      RETURNING id
    `;
    const { rows, rowCount } = await q.query<{ id: string }>(sql, [
      args.actorUserId,
      args.endedReason,
    ]);
    return {
      rowsUpdated: rowCount ?? 0,
      grantId: rows[0]?.id ?? null,
    };
  }
}
