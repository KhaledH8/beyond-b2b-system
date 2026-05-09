import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { Pool } from '@bb/db';
import { PG_POOL } from '../../database/database.module';
import { newUlid } from '../../common/ulid';
import { AuditService } from '../../audit/audit.service';
import { getRequestContext } from '../../audit/request-context';
import type { Queryable } from '../../database/queryable';
import {
  ImpersonationGrantRepository,
  type ImpersonationGrantRecord,
} from './impersonation-grant.repository';

/**
 * Default TTL for impersonation sessions (ADR-027 D3 open items).
 * The locked range is 5–240 min. This default is provisional until
 * ops/security review resolves the value; exposed as a constant so
 * it can be overridden via env without an ADR amendment.
 */
export const IMPERSONATION_DEFAULT_TTL_MINUTES =
  Number(process.env['IMPERSONATION_TTL_MINUTES'] ?? 60);

export interface StartImpersonationInput {
  readonly actorUserId: string;
  readonly actorAuth0Sub: string;
  readonly actorTenantId: string;
  readonly targetAccountId: string;
  readonly reasonText: string;
  readonly ticketRef: string;
}

export interface StartImpersonationResult {
  readonly grantId: string;
  readonly expiresAt: string;
  readonly target: {
    readonly accountId: string;
    readonly accountName: string;
  };
}

interface CoreAccountRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly account_type: string;
  readonly name: string;
}

@Injectable()
export class ImpersonationService {
  private readonly logger = new Logger(ImpersonationService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(ImpersonationGrantRepository)
    private readonly grantRepo: ImpersonationGrantRepository,
    @Inject(AuditService) private readonly auditService: AuditService,
  ) {}

  /**
   * Starts an impersonation session. Validates all ADR-027 D2 subject
   * rules, auto-ends any expired un-ended grants, then inserts a new
   * grant row and emits IMPERSONATION_STARTED in the same transaction.
   *
   * Throws:
   *   400 — missing ticketRef or reasonText
   *   403 — target not found, not AGENCY, or different tenant
   *   409 — active (non-expired) grant already exists
   */
  async startImpersonation(
    input: StartImpersonationInput,
  ): Promise<StartImpersonationResult> {
    if (!input.ticketRef.trim()) {
      await this.emitRejection(input, 'TICKET_REF_MISSING');
      throw new BadRequestException('ticketRef is required');
    }
    if (!input.reasonText.trim()) {
      await this.emitRejection(input, 'REASON_TEXT_MISSING');
      throw new BadRequestException('reasonText is required');
    }

    // Phase 1: validate target account — no transaction needed.
    const account = await this.lookupAccount(this.pool, input.targetAccountId);

    if (!account) {
      await this.emitRejection(input, 'TARGET_NOT_AGENCY');
      throw new ForbiddenException('Target account not found');
    }
    if (account.account_type !== 'AGENCY') {
      await this.emitRejection(input, 'TARGET_NOT_AGENCY');
      throw new ForbiddenException('Target account is not an AGENCY account');
    }
    if (account.tenant_id !== input.actorTenantId) {
      await this.emitRejection(input, 'TARGET_DIFFERENT_TENANT');
      throw new ForbiddenException(
        'Target account belongs to a different tenant',
      );
    }

    const ctx = getRequestContext();
    const ipAddress = ctx?.ipAddress ?? null;
    const userAgent = ctx?.userAgent ?? null;

    // Phase 2: grant management in a single transaction.
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const unended = await this.grantRepo.findUnendedByActor(
        client,
        input.actorUserId,
      );

      if (unended) {
        const isExpired = new Date(unended.expiresAt) <= new Date();
        if (!isExpired) {
          // Genuine active grant — rollback (empty tx) and reject.
          await client.query('ROLLBACK');
          await this.emitRejection(input, 'ACTIVE_GRANT_EXISTS');
          throw new ConflictException(
            'An active impersonation grant already exists. Call stop first.',
          );
        }
        // Auto-end expired grant so the unique index allows a new INSERT.
        await this.grantRepo.end(client, {
          actorUserId: input.actorUserId,
          endedReason: 'EXPIRED',
        });
        await this.auditService.emitInTransaction(client, {
          category: 'IMPERSONATION',
          kind: 'IMPERSONATION_ENDED',
          tenantId: input.actorTenantId,
          targetId: unended.id,
          payload: { grantId: unended.id, endReason: 'TTL_EXPIRED' },
        });
      }

      const grantId = newUlid();
      const expiresAt = new Date(
        Date.now() + IMPERSONATION_DEFAULT_TTL_MINUTES * 60 * 1000,
      );

      const grant = await this.grantRepo.insert(client, {
        id: grantId,
        tenantId: input.actorTenantId,
        actorUserId: input.actorUserId,
        targetAccountId: input.targetAccountId,
        reasonText: input.reasonText,
        ticketRef: input.ticketRef,
        expiresAt,
        ipAddress,
        userAgent,
      });

      await this.auditService.emitInTransaction(client, {
        category: 'IMPERSONATION',
        kind: 'IMPERSONATION_STARTED',
        tenantId: input.actorTenantId,
        targetId: grantId,
        payload: {
          grantId,
          targetAccountId: input.targetAccountId,
          targetAccountName: account.name,
          targetAccountType: account.account_type,
          ticketRef: input.ticketRef,
          reason: input.reasonText,
        },
      });

      await client.query('COMMIT');

      return {
        grantId: grant.id,
        expiresAt: grant.expiresAt,
        target: {
          accountId: input.targetAccountId,
          accountName: account.name,
        },
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Ends the actor's active impersonation grant with reason
   * OPERATOR_ENDED. Idempotent: returns { ended: false } when no
   * active grant exists.
   */
  async stopImpersonation(
    actorUserId: string,
    tenantId: string,
  ): Promise<{ ended: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const { rowsUpdated, grantId } = await this.grantRepo.end(client, {
        actorUserId,
        endedReason: 'OPERATOR_ENDED',
      });

      if (rowsUpdated > 0 && grantId) {
        await this.auditService.emitInTransaction(client, {
          category: 'IMPERSONATION',
          kind: 'IMPERSONATION_ENDED',
          tenantId,
          targetId: grantId,
          payload: { grantId, endReason: 'REQUEST_END' },
        });
      }

      await client.query('COMMIT');
      return { ended: rowsUpdated > 0 };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Returns the caller's current active grant or null. Used by
   * GET /impersonation/active and by the JwtAuthGuard hot path.
   */
  async getActiveGrant(
    actorUserId: string,
  ): Promise<ImpersonationGrantRecord | null> {
    return this.grantRepo.findActiveByActor(this.pool, actorUserId);
  }

  // ── Private helpers ──────────────────────────────────────────────────

  private async lookupAccount(
    q: Queryable,
    accountId: string,
  ): Promise<CoreAccountRow | null> {
    const { rows } = await q.query<CoreAccountRow>(
      `SELECT id, tenant_id, account_type, name
         FROM core_account WHERE id = $1`,
      [accountId],
    );
    return rows[0] ?? null;
  }

  /**
   * Emits an IMPERSONATION_START_REJECTED audit event in its own
   * short transaction. Errors are swallowed and logged — the rejection
   * itself has already been decided; a failed audit write must not
   * override that decision.
   */
  private async emitRejection(
    input: StartImpersonationInput,
    rejectReason: string,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.auditService.emitInTransaction(client, {
        category: 'IMPERSONATION',
        kind: 'IMPERSONATION_START_REJECTED',
        tenantId: input.actorTenantId,
        targetId: input.targetAccountId,
        payload: {
          targetAccountId: input.targetAccountId,
          rejectReason,
        },
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      this.logger.error(
        { err, rejectReason },
        'Failed to emit IMPERSONATION_START_REJECTED audit event',
      );
    } finally {
      client.release();
    }
  }
}
