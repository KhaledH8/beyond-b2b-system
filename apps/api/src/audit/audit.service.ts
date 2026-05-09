import { Injectable, Logger, Inject } from '@nestjs/common';
import type { Pool, PoolClient } from '@bb/db';
import { PG_POOL } from '../database/database.module';
import type { Queryable } from '../database/queryable';
import { newUlid } from '../common/ulid';
import { getRequestContext } from './request-context';
import {
  AUDIT_SCHEMA_VERSION,
  type AuditEventInput,
  type AuditEventInputBackground,
} from './audit-event.types';

/**
 * ADR-028 D7 — AuditService.
 *
 * The ONLY path through which code writes to audit_event. Repositories
 * must not write directly.
 *
 * Two public write methods:
 *
 *   emit(event)                      — best-effort background emission.
 *                                      APP and SECURITY categories only
 *                                      (compile-time + runtime enforced).
 *                                      Failure is logged and swallowed;
 *                                      the originating request succeeds.
 *
 *   emitInTransaction(client, event) — synchronous emission in the
 *                                      caller's DB transaction. Required
 *                                      for AUTH, IMPERSONATION, and
 *                                      SENSITIVE_ACCESS. If the INSERT
 *                                      fails, the exception propagates
 *                                      and the enclosing transaction
 *                                      rolls back.
 *
 * The service reads request_id, actor fields, ip_address, user_agent,
 * and impersonation_grant_id from the AsyncLocalStorage request context
 * (populated by RequestIdMiddleware and, later, JwtAuthGuard). Emitters
 * do not pass these explicitly.
 *
 * FAILURE MODES:
 *
 *   emit:              write failure → ERROR log, event dropped.
 *                      Business action completes regardless.
 *
 *   emitInTransaction: write failure → exception → transaction rollback.
 *                      Business write does not commit without audit write.
 *                      This is by design for legally-significant categories.
 */

// Categories that must never use background emit (ADR-028 D7 amendment).
const MUST_USE_TRANSACTION = new Set<string>([
  'AUTH',
  'IMPERSONATION',
  'SENSITIVE_ACCESS',
]);

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * Best-effort background emission. Accepts only APP and SECURITY.
   *
   * Calling this with AUTH, IMPERSONATION, or SENSITIVE_ACCESS is a
   * compile-time error (the AuditEventInputBackground type excludes
   * those categories). A runtime guard raises for callers that bypass
   * the type system via casts.
   */
  async emit(event: AuditEventInputBackground): Promise<void> {
    if (MUST_USE_TRANSACTION.has(event.category)) {
      // Should never reach here in correctly-typed code; runtime guard
      // for defence in depth.
      throw new Error(
        `AuditService.emit called with category '${event.category}'. ` +
          `This category requires emitInTransaction — using background ` +
          `emit risks losing the audit record on node restart. ` +
          `Fix the call site.`,
      );
    }
    try {
      await this.writeRow(this.pool, event);
    } catch (err) {
      this.logger.error(
        { err, category: event.category, kind: event.kind },
        'Background audit emit failed — event dropped',
      );
    }
  }

  /** Batch variant of emit. Same category restriction applies. */
  async emitMany(events: readonly AuditEventInputBackground[]): Promise<void> {
    for (const event of events) {
      await this.emit(event);
    }
  }

  /**
   * Synchronous emission in the caller's DB transaction.
   *
   * Required for AUTH, IMPERSONATION, and SENSITIVE_ACCESS. Pass the
   * checked-out PoolClient that owns the enclosing BEGIN. If the
   * INSERT fails (constraint violation, partition missing, etc.), the
   * exception propagates to the caller and the transaction rolls back.
   */
  async emitInTransaction(
    client: PoolClient,
    event: AuditEventInput,
  ): Promise<void> {
    await this.writeRow(client, event);
  }

  // ── Private ─────────────────────────────────────────────────────────

  private async writeRow(q: Queryable, event: AuditEventInput): Promise<void> {
    const ctx = getRequestContext();

    const actorKind = ctx?.actorKind ?? 'ANONYMOUS';
    const actorUserId = ctx?.actorUserId ?? null;
    const actorApiKeyId = ctx?.actorApiKeyId ?? null;
    const actorLabel = ctx?.actorLabel ?? null;
    const requestId = ctx?.requestId ?? null;
    const impersonationGrantId = ctx?.impersonationGrantId ?? null;
    const ipAddress = ctx?.ipAddress ?? null;
    const userAgent = ctx?.userAgent ?? null;

    const targetKind = deriveTargetKind(event);
    const targetId =
      'targetId' in event
        ? (event as { targetId?: string }).targetId ?? null
        : null;

    await q.query(
      `INSERT INTO audit_event (
         id, occurred_at, recorded_at, schema_version,
         category, kind, tenant_id,
         actor_kind, actor_user_id, actor_api_key_id, actor_label,
         target_kind, target_id,
         request_id, impersonation_grant_id,
         ip_address, user_agent, payload
       ) VALUES (
         $1,  $2,  $3,  $4,
         $5,  $6,  $7,
         $8,  $9,  $10, $11,
         $12, $13,
         $14, $15,
         $16::inet, $17, $18::jsonb
       )`,
      [
        newUlid(), new Date(), new Date(), AUDIT_SCHEMA_VERSION,
        event.category, event.kind, event.tenantId,
        actorKind, actorUserId, actorApiKeyId, actorLabel,
        targetKind, targetId,
        requestId, impersonationGrantId,
        ipAddress, userAgent,
        JSON.stringify(event.payload),
      ],
    );
  }
}

function deriveTargetKind(event: AuditEventInput): string | null {
  switch (event.category) {
    case 'APP':
      if (event.kind.startsWith('BOOKING_')) return 'BOOKING';
      if (event.kind.startsWith('LEDGER_')) return 'LEDGER_ENTRY';
      if (event.kind.startsWith('MARKUP_')) return 'MARKUP_RULE';
      return null;
    case 'AUTH':
      if (event.kind.startsWith('USER_')) return 'USER';
      if (event.kind.startsWith('ROLE_')) return 'USER_ROLE';
      if (event.kind.startsWith('MEMBERSHIP_')) return 'USER';
      if (event.kind.startsWith('API_KEY_')) return 'API_KEY';
      return null;
    case 'IMPERSONATION':
      return 'IMPERSONATION_GRANT';
    case 'SECURITY':
      return null;
    default:
      // SENSITIVE_ACCESS and any future categories with no defined target.
      return null;
  }
}
