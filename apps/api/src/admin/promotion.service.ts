import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { AccountType, PromotionKind } from '@bb/domain';
import { newUlid } from '../common/ulid';
import {
  PromotionAdminRepository,
  type PromotionAdminRow,
} from './promotion.repository';
import { AuditLogRepository } from './audit-log.repository';

export interface CreatePromotionInput {
  tenantId: string;
  supplierHotelId: string;
  kind: PromotionKind;
  priority: number;
  accountType?: AccountType;
  validFrom?: string;
  validTo?: string;
}

export interface PatchPromotionInput {
  kind?: PromotionKind;
  priority?: number;
  accountType?: AccountType | null;
  validFrom?: string | null;
  validTo?: string | null;
  status?: 'ACTIVE' | 'INACTIVE';
}

@Injectable()
export class PromotionAdminService {
  constructor(
    @Inject(PromotionAdminRepository)
    private readonly repo: PromotionAdminRepository,
    @Inject(AuditLogRepository)
    private readonly audit: AuditLogRepository,
  ) {}

  async create(
    input: CreatePromotionInput,
    actorId: string,
  ): Promise<PromotionAdminRow> {
    requireValidWindow(input.validFrom, input.validTo);
    const row = await this.repo.insert({
      id: newUlid(),
      tenantId: input.tenantId,
      supplierHotelId: input.supplierHotelId,
      kind: input.kind,
      priority: input.priority,
      ...(input.accountType !== undefined
        ? { accountType: input.accountType }
        : {}),
      ...(input.validFrom !== undefined ? { validFrom: input.validFrom } : {}),
      ...(input.validTo !== undefined ? { validTo: input.validTo } : {}),
    });
    await this.audit.write({
      tenantId: input.tenantId,
      actorId,
      resourceType: 'promotion',
      resourceId: row.id,
      operation: 'CREATE',
      payload: input as unknown as Record<string, unknown>,
    });
    return row;
  }

  async patch(
    id: string,
    tenantId: string,
    patch: PatchPromotionInput,
    actorId: string,
  ): Promise<PromotionAdminRow> {
    if (patch.validFrom !== undefined || patch.validTo !== undefined) {
      const existing = await this.repo.findById(id, tenantId);
      if (!existing) {
        throw new BadRequestException(`promotion ${id} not found`);
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
      resourceType: 'promotion',
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
  ): Promise<PromotionAdminRow> {
    const row = await this.repo.softDelete(id, tenantId);
    await this.audit.write({
      tenantId,
      actorId,
      resourceType: 'promotion',
      resourceId: id,
      operation: 'SOFT_DELETE',
      payload: {},
    });
    return row;
  }

  findById(id: string, tenantId: string): Promise<PromotionAdminRow | null> {
    return this.repo.findById(id, tenantId);
  }

  list(
    filter: Parameters<PromotionAdminRepository['list']>[0],
  ): Promise<ReadonlyArray<PromotionAdminRow>> {
    return this.repo.list(filter);
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
