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
} from '@nestjs/common';
import type { AccountType, MarkupRuleScope } from '@bb/domain';
import {
  ENUM_ACCOUNT_TYPE,
  ENUM_SCOPE,
  ENUM_STATUS,
  asObject,
  optionalDecimalString,
  optionalEnum,
  optionalInt,
  optionalIsoTimestamp,
  optionalString,
  optionalUlid,
  rejectExtraKeys,
  requireDecimalString,
  requireEnum,
  requireInt,
  requireUlid,
  requireUlidQuery,
} from './validation';
import {
  MarkupRuleAdminService,
  type CreateMarkupRuleInput,
  type PatchMarkupRuleInput,
} from './markup-rule.service';
import type { MarkupRuleAdminRow } from './markup-rule.repository';

/**
 * Admin CRUD over `pricing_markup_rule`.
 *
 * Internal-only — mounted under `/internal/admin/...` like the other
 * Hotelbeds dev/ops endpoints. No auth yet; same gating applies as
 * elsewhere in this codebase: the auth guard wraps `/internal/...`
 * once the auth module ships.
 *
 * Soft-delete only — DELETE flips status to `INACTIVE`. Rules are
 * never DROPped because their ids may appear in older pricing
 * traces and the audit trail must keep dereferencing.
 */
@Controller('internal/admin/pricing/markup-rules')
export class MarkupRuleAdminController {
  constructor(
    @Inject(MarkupRuleAdminService)
    private readonly service: MarkupRuleAdminService,
  ) {}

  @Post()
  async create(@Body() body: unknown): Promise<MarkupRuleAdminRow> {
    return this.service.create(parseCreate(body));
  }

  @Get()
  async list(
    @Query() query: Record<string, string>,
  ): Promise<{ count: number; items: ReadonlyArray<MarkupRuleAdminRow> }> {
    const filter = parseListFilter(query);
    const items = await this.service.list(filter);
    return { count: items.length, items };
  }

  @Get(':id')
  async getOne(
    @Param('id') id: string,
    @Query('tenantId') tenantIdRaw: string,
  ): Promise<MarkupRuleAdminRow> {
    const tenantId = requireUlidQuery(tenantIdRaw, 'tenantId');
    const row = await this.service.findById(id, tenantId);
    if (!row) throw new NotFoundException(`markup rule ${id} not found`);
    return row;
  }

  @Patch(':id')
  async patch(
    @Param('id') id: string,
    @Query('tenantId') tenantIdRaw: string,
    @Body() body: unknown,
  ): Promise<MarkupRuleAdminRow> {
    const tenantId = requireUlidQuery(tenantIdRaw, 'tenantId');
    return this.service.patch(id, tenantId, parsePatch(body));
  }

  @Delete(':id')
  async softDelete(
    @Param('id') id: string,
    @Query('tenantId') tenantIdRaw: string,
  ): Promise<MarkupRuleAdminRow> {
    const tenantId = requireUlidQuery(tenantIdRaw, 'tenantId');
    return this.service.softDelete(id, tenantId);
  }
}

// ---------------------------------------------------------------------------
// Body / query parsers
// ---------------------------------------------------------------------------

function parseCreate(body: unknown): CreateMarkupRuleInput {
  const o = asObject(body);
  rejectExtraKeys(o, [
    'tenantId',
    'scope',
    'accountId',
    'supplierHotelId',
    'accountType',
    'percentValue',
    'priority',
    'validFrom',
    'validTo',
  ]);
  const tenantId = requireUlid(o, 'tenantId');
  const scope = requireEnum<MarkupRuleScope>(o, 'scope', ENUM_SCOPE);
  const percentValue = requireDecimalString(o, 'percentValue', {
    min: 0,
    max: 1000,
  });
  const priority = requireInt(o, 'priority', { min: 0, max: 1_000_000 });
  return {
    tenantId,
    scope,
    ...(optionalUlid(o, 'accountId') !== undefined
      ? { accountId: optionalUlid(o, 'accountId')! }
      : {}),
    ...(optionalUlid(o, 'supplierHotelId') !== undefined
      ? { supplierHotelId: optionalUlid(o, 'supplierHotelId')! }
      : {}),
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
    percentValue,
    priority,
    ...(optionalIsoTimestamp(o, 'validFrom') !== undefined
      ? { validFrom: optionalIsoTimestamp(o, 'validFrom')! }
      : {}),
    ...(optionalIsoTimestamp(o, 'validTo') !== undefined
      ? { validTo: optionalIsoTimestamp(o, 'validTo')! }
      : {}),
  };
}

function parsePatch(body: unknown): PatchMarkupRuleInput {
  const o = asObject(body);
  rejectExtraKeys(o, [
    'percentValue',
    'priority',
    'validFrom',
    'validTo',
    'status',
  ]);
  const out: PatchMarkupRuleInput = {};
  const percentValue = optionalDecimalString(o, 'percentValue', {
    min: 0,
    max: 1000,
  });
  if (percentValue !== undefined) out.percentValue = percentValue;
  const priority = optionalInt(o, 'priority', { min: 0, max: 1_000_000 });
  if (priority !== undefined) out.priority = priority;
  // Distinguish "set to null" (clear the bound) from "absent" (leave
  // unchanged). The repo's CASE-on-boolean dispatch reads this
  // distinction off whether the patch field key is present.
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
): Parameters<MarkupRuleAdminService['list']>[0] {
  const o = query as Record<string, unknown>;
  const tenantId = requireUlid(o, 'tenantId');
  const filter: Parameters<MarkupRuleAdminService['list']>[0] = { tenantId };
  const scope = optionalEnum<MarkupRuleScope>(o, 'scope', ENUM_SCOPE);
  if (scope !== undefined) filter.scope = scope;
  const accountId = optionalUlid(o, 'accountId');
  if (accountId !== undefined) filter.accountId = accountId;
  const supplierHotelId = optionalUlid(o, 'supplierHotelId');
  if (supplierHotelId !== undefined) filter.supplierHotelId = supplierHotelId;
  const accountType = optionalEnum<AccountType>(
    o,
    'accountType',
    ENUM_ACCOUNT_TYPE,
  );
  if (accountType !== undefined) filter.accountType = accountType;
  const status = optionalEnum<'ACTIVE' | 'INACTIVE'>(o, 'status', ENUM_STATUS);
  if (status !== undefined) filter.status = status;
  const limit = optionalString(o, 'limit');
  if (limit !== undefined) {
    const n = Number.parseInt(limit, 10);
    if (!Number.isInteger(n) || n < 1 || n > 1000) {
      filter.limit = 100;
    } else {
      filter.limit = n;
    }
  }
  const offset = optionalString(o, 'offset');
  if (offset !== undefined) {
    const n = Number.parseInt(offset, 10);
    if (Number.isInteger(n) && n >= 0) filter.offset = n;
  }
  return filter;
}
