import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { AccountType, MarkupRuleScope } from '@bb/domain';
import { newUlid } from '../common/ulid';
import {
  MarkupRuleAdminRepository,
  type MarkupRuleAdminRow,
} from './markup-rule.repository';
import { AuditLogRepository } from './audit-log.repository';

export interface CreateMarkupRuleInput {
  tenantId: string;
  scope: MarkupRuleScope;
  // Exactly one of these is required, matching scope:
  accountId?: string;
  supplierHotelId?: string;
  accountType?: AccountType;

  percentValue: string;
  priority: number;
  validFrom?: string;
  validTo?: string;
}

export interface PatchMarkupRuleInput {
  percentValue?: string;
  priority?: number;
  validFrom?: string | null;
  validTo?: string | null;
  status?: 'ACTIVE' | 'INACTIVE';
}

/**
 * Admin service over `pricing_markup_rule`. Owns the create/patch
 * invariants the DB layer can't fully express:
 *   - Exactly one scope key is set, matching `scope`. (DB enforces
 *     this too; the service rejects early with a 400 instead of
 *     letting the constraint fire as a 409.)
 *   - `validTo > validFrom` when both are present (also enforced by
 *     the DB CHECK; we pre-check so the patch flow can compose old
 *     and new values correctly).
 *   - Soft-delete-only: rows transition to `INACTIVE`, never DROP.
 */
@Injectable()
export class MarkupRuleAdminService {
  constructor(
    @Inject(MarkupRuleAdminRepository)
    private readonly repo: MarkupRuleAdminRepository,
    @Inject(AuditLogRepository)
    private readonly audit: AuditLogRepository,
  ) {}

  async create(
    input: CreateMarkupRuleInput,
    actorId: string,
  ): Promise<MarkupRuleAdminRow> {
    requireSingleScopeKey(input);
    requireValidWindow(input.validFrom, input.validTo);

    const row = await this.repo.insert({
      id: newUlid(),
      tenantId: input.tenantId,
      scope: input.scope,
      ...(input.accountId !== undefined ? { accountId: input.accountId } : {}),
      ...(input.supplierHotelId !== undefined
        ? { supplierHotelId: input.supplierHotelId }
        : {}),
      ...(input.accountType !== undefined
        ? { accountType: input.accountType }
        : {}),
      percentValue: input.percentValue,
      priority: input.priority,
      ...(input.validFrom !== undefined ? { validFrom: input.validFrom } : {}),
      ...(input.validTo !== undefined ? { validTo: input.validTo } : {}),
    });
    await this.audit.write({
      tenantId: input.tenantId,
      actorId,
      resourceType: 'markup_rule',
      resourceId: row.id,
      operation: 'CREATE',
      payload: input as unknown as Record<string, unknown>,
    });
    return row;
  }

  async patch(
    id: string,
    tenantId: string,
    patch: PatchMarkupRuleInput,
    actorId: string,
  ): Promise<MarkupRuleAdminRow> {
    // If the patch includes a window edit, evaluate the result of
    // composing patch + existing row and reject early when the
    // composed window is invalid.
    if (patch.validFrom !== undefined || patch.validTo !== undefined) {
      const existing = await this.repo.findById(id, tenantId);
      if (!existing) {
        throw new BadRequestException(`markup rule ${id} not found`);
      }
      const nextFrom =
        patch.validFrom !== undefined ? patch.validFrom : existing.validFrom;
      const nextTo =
        patch.validTo !== undefined ? patch.validTo : existing.validTo;
      requireValidWindow(nextFrom ?? undefined, nextTo ?? undefined);
    }
    const row = await this.repo.patch(id, tenantId, patch);
    await this.audit.write({
      tenantId,
      actorId,
      resourceType: 'markup_rule',
      resourceId: id,
      operation: 'PATCH',
      payload: patch as unknown as Record<string, unknown>,
    });
    return row;
  }

  async softDelete(
    id: string,
    tenantId: string,
    actorId: string,
  ): Promise<MarkupRuleAdminRow> {
    const row = await this.repo.softDelete(id, tenantId);
    await this.audit.write({
      tenantId,
      actorId,
      resourceType: 'markup_rule',
      resourceId: id,
      operation: 'SOFT_DELETE',
      payload: {},
    });
    return row;
  }

  findById(id: string, tenantId: string): Promise<MarkupRuleAdminRow | null> {
    return this.repo.findById(id, tenantId);
  }

  list(filter: Parameters<MarkupRuleAdminRepository['list']>[0]): Promise<
    ReadonlyArray<MarkupRuleAdminRow>
  > {
    return this.repo.list(filter);
  }
}

function requireSingleScopeKey(input: CreateMarkupRuleInput): void {
  switch (input.scope) {
    case 'ACCOUNT':
      if (!input.accountId) {
        throw new BadRequestException('scope=ACCOUNT requires accountId');
      }
      if (input.supplierHotelId || input.accountType) {
        throw new BadRequestException(
          'scope=ACCOUNT must not set supplierHotelId or accountType',
        );
      }
      return;
    case 'HOTEL':
      if (!input.supplierHotelId) {
        throw new BadRequestException('scope=HOTEL requires supplierHotelId');
      }
      if (input.accountId || input.accountType) {
        throw new BadRequestException(
          'scope=HOTEL must not set accountId or accountType',
        );
      }
      return;
    case 'CHANNEL':
      if (!input.accountType) {
        throw new BadRequestException('scope=CHANNEL requires accountType');
      }
      if (input.accountId || input.supplierHotelId) {
        throw new BadRequestException(
          'scope=CHANNEL must not set accountId or supplierHotelId',
        );
      }
      return;
  }
}

function requireValidWindow(
  validFrom: string | undefined,
  validTo: string | undefined,
): void {
  if (validFrom && validTo) {
    if (Date.parse(validTo) <= Date.parse(validFrom)) {
      throw new BadRequestException('validTo must be strictly after validFrom');
    }
  }
}
