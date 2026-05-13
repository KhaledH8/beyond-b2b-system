import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from '@bb/db';
import { PG_POOL } from '../database/database.module';

/**
 * Row shape returned by the audit-event LIST query. Mirrors the
 * `audit_event` columns one-for-one (no joins).
 */
export interface AuditEventRow {
  readonly id: string;
  readonly occurred_at: Date | string;
  readonly recorded_at: Date | string;
  readonly schema_version: number;
  readonly category: string;
  readonly kind: string;
  readonly tenant_id: string;
  readonly actor_kind: string;
  readonly actor_user_id: string | null;
  readonly actor_api_key_id: string | null;
  readonly actor_label: string | null;
  readonly target_kind: string | null;
  readonly target_id: string | null;
  readonly request_id: string | null;
  readonly impersonation_grant_id: string | null;
  readonly ip_address: string | null;
  readonly user_agent: string | null;
  readonly payload: unknown;
}

export interface ListAuditEventsQuery {
  /** From AuthContext. Hard-scopes the query — never null. */
  readonly tenantId: string;
  readonly category?: string;
  readonly kind?: string;
  readonly actorUserId?: string;
  readonly targetKind?: string;
  readonly targetId?: string;
  readonly requestId?: string;
  readonly impersonationGrantId?: string;
  readonly occurredFrom?: Date;
  readonly occurredTo?: Date;
  /**
   * True only when the caller holds `AUDIT_READ_SENSITIVE`. False
   * adds `category != 'SENSITIVE_ACCESS'` to the WHERE clause so
   * sensitive rows never reach the API layer.
   */
  readonly includeSensitive: boolean;
  /** `(occurred_at, id)` of the last row from the previous page. */
  readonly cursor?: { readonly occurredAt: Date; readonly id: string };
  /** Already clamped 1..200 at the service. Add +1 for has-more detection. */
  readonly limit: number;
}

/**
 * Read-only repository for `GET /admin/audit/events` (ADR-028 D9).
 *
 * All parameters are positional. No string interpolation. The WHERE
 * clause uses the `$N::T IS NULL` short-circuit pattern so the same
 * statement covers all filter combinations.
 *
 * Sort order is `occurred_at DESC, id DESC` — matches the partition-
 * propagated indexes and stable under inserts when combined with the
 * `(occurred_at, id)` cursor.
 */
@Injectable()
export class AuditEventRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async listEvents(input: ListAuditEventsQuery): Promise<AuditEventRow[]> {
    const sql = `
      SELECT id, occurred_at, recorded_at, schema_version,
             category, kind, tenant_id,
             actor_kind, actor_user_id, actor_api_key_id, actor_label,
             target_kind, target_id,
             request_id, impersonation_grant_id,
             ip_address::text AS ip_address,
             user_agent, payload
        FROM audit_event
       WHERE tenant_id = $1
         AND ($2::text       IS NULL OR category               = $2::text)
         AND ($3::text       IS NULL OR kind                   = $3::text)
         AND ($4::char(26)   IS NULL OR actor_user_id          = $4::char(26))
         AND ($5::text       IS NULL OR target_kind            = $5::text)
         AND ($6::text       IS NULL OR target_id              = $6::text)
         AND ($7::char(26)   IS NULL OR request_id             = $7::char(26))
         AND ($8::char(26)   IS NULL OR impersonation_grant_id = $8::char(26))
         AND ($9::timestamptz  IS NULL OR occurred_at >= $9::timestamptz)
         AND ($10::timestamptz IS NULL OR occurred_at <  $10::timestamptz)
         AND ($11::boolean OR category != 'SENSITIVE_ACCESS')
         AND ($12::timestamptz IS NULL
              OR (occurred_at, id) < ($12::timestamptz, $13::char(26)))
       ORDER BY occurred_at DESC, id DESC
       LIMIT $14
    `;
    const params: unknown[] = [
      input.tenantId,
      input.category ?? null,
      input.kind ?? null,
      input.actorUserId ?? null,
      input.targetKind ?? null,
      input.targetId ?? null,
      input.requestId ?? null,
      input.impersonationGrantId ?? null,
      input.occurredFrom ?? null,
      input.occurredTo ?? null,
      input.includeSensitive,
      input.cursor?.occurredAt ?? null,
      input.cursor?.id ?? null,
      input.limit,
    ];
    const { rows } = await this.pool.query<AuditEventRow>(sql, params);
    return rows;
  }
}
