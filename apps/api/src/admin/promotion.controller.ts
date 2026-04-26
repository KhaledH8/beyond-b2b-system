import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { InternalAuthGuard } from '../internal-auth/internal-auth.guard';
import type { AccountType, PromotionKind } from '@bb/domain';
import {
  ENUM_ACCOUNT_TYPE,
  ENUM_PROMOTION_KIND,
  ENUM_STATUS,
  asObject,
  optionalEnum,
  optionalInt,
  optionalIsoTimestamp,
  optionalString,
  optionalUlid,
  rejectExtraKeys,
  requireEnum,
  requireInt,
  requireUlid,
  requireUlidQuery,
} from './validation';
import {
  PromotionAdminService,
  type CreatePromotionInput,
  type PatchPromotionInput,
} from './promotion.service';
import type { PromotionAdminRow } from './promotion.repository';

/**
 * Admin CRUD over `merch_promotion`.
 *
 * Internal-only — see `MarkupRuleAdminController` for the same auth /
 * mounting rationale. Soft-delete only (status flips to INACTIVE).
 *
 * Search-side `PgPromotionRepository` filters on `status = 'ACTIVE'`,
 * so toggling a promotion off is instantaneous from the user's
 * point of view but the row remains for audit and any later
 * reactivation.
 */
@UseGuards(InternalAuthGuard)
@Controller('internal/admin/merchandising/promotions')
export class PromotionAdminController {
  constructor(
    @Inject(PromotionAdminService)
    private readonly service: PromotionAdminService,
  ) {}

  @Post()
  async create(@Body() body: unknown): Promise<PromotionAdminRow> {
    return this.service.create(parseCreate(body));
  }

  @Get()
  async list(
    @Query() query: Record<string, string>,
  ): Promise<{ count: number; items: ReadonlyArray<PromotionAdminRow> }> {
    const filter = parseListFilter(query);
    const items = await this.service.list(filter);
    return { count: items.length, items };
  }

  @Get(':id')
  async getOne(
    @Param('id') id: string,
    @Query('tenantId') tenantIdRaw: string,
  ): Promise<PromotionAdminRow> {
    const tenantId = requireUlidQuery(tenantIdRaw, 'tenantId');
    const row = await this.service.findById(id, tenantId);
    if (!row) throw new NotFoundException(`promotion ${id} not found`);
    return row;
  }

  @Patch(':id')
  async patch(
    @Param('id') id: string,
    @Query('tenantId') tenantIdRaw: string,
    @Body() body: unknown,
  ): Promise<PromotionAdminRow> {
    const tenantId = requireUlidQuery(tenantIdRaw, 'tenantId');
    return this.service.patch(id, tenantId, parsePatch(body));
  }

  @Delete(':id')
  async softDelete(
    @Param('id') id: string,
    @Query('tenantId') tenantIdRaw: string,
  ): Promise<PromotionAdminRow> {
    const tenantId = requireUlidQuery(tenantIdRaw, 'tenantId');
    return this.service.softDelete(id, tenantId);
  }
}

// ---------------------------------------------------------------------------
// Body / query parsers
// ---------------------------------------------------------------------------

function parseCreate(body: unknown): CreatePromotionInput {
  const o = asObject(body);
  rejectExtraKeys(o, [
    'tenantId',
    'supplierHotelId',
    'kind',
    'priority',
    'accountType',
    'validFrom',
    'validTo',
  ]);
  const tenantId = requireUlid(o, 'tenantId');
  const supplierHotelId = requireUlid(o, 'supplierHotelId');
  const kind = requireEnum<PromotionKind>(o, 'kind', ENUM_PROMOTION_KIND);
  const priority = requireInt(o, 'priority', { min: 0, max: 1_000_000 });
  return {
    tenantId,
    supplierHotelId,
    kind,
    priority,
    ...(optionalEnum<AccountType>(o, 'accountType', ENUM_ACCOUNT_TYPE) !==
    undefined
      ? {
          accountType: optionalEnum<AccountType>(
            o,
            'accountType',
            ENUM_ACCOUNT_TYPE,
          )!,
        }
      : {}),
    ...(optionalIsoTimestamp(o, 'validFrom') !== undefined
      ? { validFrom: optionalIsoTimestamp(o, 'validFrom')! }
      : {}),
    ...(optionalIsoTimestamp(o, 'validTo') !== undefined
      ? { validTo: optionalIsoTimestamp(o, 'validTo')! }
      : {}),
  };
}

function parsePatch(body: unknown): PatchPromotionInput {
  const o = asObject(body);
  rejectExtraKeys(o, [
    'kind',
    'priority',
    'accountType',
    'validFrom',
    'validTo',
    'status',
  ]);
  const out: PatchPromotionInput = {};
  const kind = optionalEnum<PromotionKind>(o, 'kind', ENUM_PROMOTION_KIND);
  if (kind !== undefined) out.kind = kind;
  const priority = optionalInt(o, 'priority', { min: 0, max: 1_000_000 });
  if (priority !== undefined) out.priority = priority;
  if (Object.prototype.hasOwnProperty.call(o, 'accountType')) {
    out.accountType =
      optionalEnum<AccountType>(o, 'accountType', ENUM_ACCOUNT_TYPE) ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(o, 'validFrom')) {
    out.validFrom = optionalIsoTimestamp(o, 'validFrom') ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(o, 'validTo')) {
    out.validTo = optionalIsoTimestamp(o, 'validTo') ?? null;
  }
  const status = optionalEnum<'ACTIVE' | 'INACTIVE'>(o, 'status', ENUM_STATUS);
  if (status !== undefined) out.status = status;
  return out;
}

function parseListFilter(
  query: Record<string, string>,
): Parameters<PromotionAdminService['list']>[0] {
  const o = query as Record<string, unknown>;
  const tenantId = requireUlid(o, 'tenantId');
  const filter: Parameters<PromotionAdminService['list']>[0] = { tenantId };
  const supplierHotelId = optionalUlid(o, 'supplierHotelId');
  if (supplierHotelId !== undefined) filter.supplierHotelId = supplierHotelId;
  const accountType = optionalEnum<AccountType>(
    o,
    'accountType',
    ENUM_ACCOUNT_TYPE,
  );
  if (accountType !== undefined) filter.accountType = accountType;
  const kind = optionalEnum<PromotionKind>(o, 'kind', ENUM_PROMOTION_KIND);
  if (kind !== undefined) filter.kind = kind;
  const status = optionalEnum<'ACTIVE' | 'INACTIVE'>(o, 'status', ENUM_STATUS);
  if (status !== undefined) filter.status = status;
  const limit = optionalString(o, 'limit');
  if (limit !== undefined) {
    const n = Number.parseInt(limit, 10);
    if (Number.isInteger(n) && n >= 1 && n <= 1000) filter.limit = n;
  }
  const offset = optionalString(o, 'offset');
  if (offset !== undefined) {
    const n = Number.parseInt(offset, 10);
    if (Number.isInteger(n) && n >= 0) filter.offset = n;
  }
  return filter;
}
