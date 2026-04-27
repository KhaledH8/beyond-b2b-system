import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { InternalAuthGuard } from '../internal-auth/internal-auth.guard';
import { Actor } from '../internal-auth/actor.decorator';
import type { InternalActor } from '../internal-auth/internal-actor';
import {
  asObject,
  optionalIsoTimestamp,
  optionalUlid,
  rejectExtraKeys,
  requireEnum,
  requireIsoTimestamp,
  requireString,
  requireUlid,
  requireUlidQuery,
  ENUM_RESTRICTION_KIND,
  requireParamsObject,
  type RestrictionKind,
} from './validation';
import {
  DirectContractsService,
  type CreateContractRestrictionInput,
  type CreateSupplierRestrictionInput,
} from './direct-contracts.service';
import type { RestrictionAdminRow } from './restriction.repository';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Contract-scoped restrictions surface.
 *
 * Mutation endpoints are limited to create + supersede — there is no
 * patch and no delete (ADR-023 D8). Supersede is exposed at
 * `POST .../:id/supersede` to make the intent explicit at the URL
 * level; the body is a complete new restriction shape, identical to
 * the create body.
 */
@UseGuards(InternalAuthGuard)
@Controller('internal/admin/direct-contracts/contracts/:contractId/restrictions')
export class ContractRestrictionAdminController {
  constructor(
    @Inject(DirectContractsService)
    private readonly service: DirectContractsService,
  ) {}

  @Post()
  async create(
    @Param('contractId') contractId: string,
    @Body() body: unknown,
    @Actor() actor: InternalActor,
  ): Promise<RestrictionAdminRow> {
    return this.service.createContractRestriction(
      parseContractCreate(contractId, body),
      actor.actorId,
    );
  }

  @Get()
  async list(
    @Param('contractId') contractId: string,
    @Query('tenantId') tenantIdRaw: string,
    @Query('seasonId') seasonIdRaw?: string,
    @Query('includeSuperseded') includeSupersededRaw?: string,
  ): Promise<{ count: number; items: ReadonlyArray<RestrictionAdminRow> }> {
    const tenantId = requireUlidQuery(tenantIdRaw, 'tenantId');
    const seasonId = seasonIdRaw
      ? requireUlidQuery(seasonIdRaw, 'seasonId')
      : undefined;
    const includeSuperseded = parseBoolean(
      includeSupersededRaw,
      'includeSuperseded',
    );
    const items = await this.service.listContractRestrictions(
      contractId,
      tenantId,
      {
        ...(seasonId !== undefined ? { seasonId } : {}),
        includeSuperseded,
      },
    );
    return { count: items.length, items };
  }

  @Get(':id')
  async getOne(
    @Param('contractId') contractId: string,
    @Param('id') id: string,
    @Query('tenantId') tenantIdRaw: string,
  ): Promise<RestrictionAdminRow> {
    const tenantId = requireUlidQuery(tenantIdRaw, 'tenantId');
    const row = await this.service.findContractRestrictionById(
      contractId,
      tenantId,
      id,
    );
    if (!row) throw new NotFoundException(`restriction ${id} not found`);
    return row;
  }

  @Post(':id/supersede')
  async supersede(
    @Param('contractId') contractId: string,
    @Param('id') id: string,
    @Query('tenantId') tenantIdRaw: string,
    @Body() body: unknown,
    @Actor() actor: InternalActor,
  ): Promise<RestrictionAdminRow> {
    const tenantId = requireUlidQuery(tenantIdRaw, 'tenantId');
    return this.service.supersedeContractRestriction(
      contractId,
      tenantId,
      id,
      parseContractCreate(contractId, body),
      actor.actorId,
    );
  }
}

/**
 * Supplier-default restrictions surface (`contract_id IS NULL`).
 *
 * Allows the channel-manager kinds (RELEASE_HOURS / CUTOFF_HOURS)
 * because there is no contract scope here and the model stays
 * unified for future channel-manager adapters. The controller still
 * requires the supplier to be `source_type = 'DIRECT'` via the
 * service guard, so the surface remains tied to the direct-contracts
 * module's mental model.
 */
@UseGuards(InternalAuthGuard)
@Controller('internal/admin/direct-contracts/supplier-restrictions')
export class SupplierRestrictionAdminController {
  constructor(
    @Inject(DirectContractsService)
    private readonly service: DirectContractsService,
  ) {}

  @Post()
  async create(
    @Body() body: unknown,
    @Actor() actor: InternalActor,
  ): Promise<RestrictionAdminRow> {
    return this.service.createSupplierRestriction(
      parseSupplierCreate(body),
      actor.actorId,
    );
  }

  @Get()
  async list(
    @Query('tenantId') tenantIdRaw: string,
    @Query('supplierId') supplierIdRaw: string,
    @Query('canonicalHotelId') canonicalHotelIdRaw: string,
    @Query('includeSuperseded') includeSupersededRaw?: string,
  ): Promise<{ count: number; items: ReadonlyArray<RestrictionAdminRow> }> {
    const tenantId = requireUlidQuery(tenantIdRaw, 'tenantId');
    const supplierId = requireUlidQuery(supplierIdRaw, 'supplierId');
    const canonicalHotelId = requireUlidQuery(
      canonicalHotelIdRaw,
      'canonicalHotelId',
    );
    const includeSuperseded = parseBoolean(
      includeSupersededRaw,
      'includeSuperseded',
    );
    const items = await this.service.listSupplierRestrictions({
      tenantId,
      supplierId,
      canonicalHotelId,
      includeSuperseded,
    });
    return { count: items.length, items };
  }

  @Get(':id')
  async getOne(
    @Param('id') id: string,
    @Query('tenantId') tenantIdRaw: string,
  ): Promise<RestrictionAdminRow> {
    const tenantId = requireUlidQuery(tenantIdRaw, 'tenantId');
    const row = await this.service.findSupplierRestrictionById(tenantId, id);
    if (!row) throw new NotFoundException(`restriction ${id} not found`);
    return row;
  }

  @Post(':id/supersede')
  async supersede(
    @Param('id') id: string,
    @Query('tenantId') tenantIdRaw: string,
    @Body() body: unknown,
    @Actor() actor: InternalActor,
  ): Promise<RestrictionAdminRow> {
    const tenantId = requireUlidQuery(tenantIdRaw, 'tenantId');
    return this.service.supersedeSupplierRestriction(
      tenantId,
      id,
      parseSupplierCreate(body),
      actor.actorId,
    );
  }
}

// ---------------------------------------------------------------------------
// Body parsers
// ---------------------------------------------------------------------------

function parseContractCreate(
  contractId: string,
  body: unknown,
): CreateContractRestrictionInput {
  const o = asObject(body);
  rejectExtraKeys(o, [
    'tenantId',
    'supplierId',
    'canonicalHotelId',
    'ratePlanId',
    'roomTypeId',
    'seasonId',
    'stayDate',
    'restrictionKind',
    'params',
    'effectiveFrom',
    'effectiveTo',
  ]);
  return {
    contractId,
    tenantId: requireUlid(o, 'tenantId'),
    supplierId: requireUlid(o, 'supplierId'),
    canonicalHotelId: requireUlid(o, 'canonicalHotelId'),
    ratePlanId: optionalUlid(o, 'ratePlanId') ?? null,
    roomTypeId: optionalUlid(o, 'roomTypeId') ?? null,
    seasonId: optionalUlid(o, 'seasonId') ?? null,
    stayDate: requireStayDate(o),
    restrictionKind: requireEnum<RestrictionKind>(
      o,
      'restrictionKind',
      ENUM_RESTRICTION_KIND,
    ),
    params: requireParamsObject(o),
    effectiveFrom: requireIsoTimestamp(o, 'effectiveFrom'),
    effectiveTo: optionalIsoTimestamp(o, 'effectiveTo') ?? null,
  };
}

function parseSupplierCreate(body: unknown): CreateSupplierRestrictionInput {
  const o = asObject(body);
  rejectExtraKeys(o, [
    'tenantId',
    'supplierId',
    'canonicalHotelId',
    'ratePlanId',
    'roomTypeId',
    'stayDate',
    'restrictionKind',
    'params',
    'effectiveFrom',
    'effectiveTo',
  ]);
  return {
    tenantId: requireUlid(o, 'tenantId'),
    supplierId: requireUlid(o, 'supplierId'),
    canonicalHotelId: requireUlid(o, 'canonicalHotelId'),
    ratePlanId: optionalUlid(o, 'ratePlanId') ?? null,
    roomTypeId: optionalUlid(o, 'roomTypeId') ?? null,
    stayDate: requireStayDate(o),
    restrictionKind: requireEnum<RestrictionKind>(
      o,
      'restrictionKind',
      ENUM_RESTRICTION_KIND,
    ),
    params: requireParamsObject(o),
    effectiveFrom: requireIsoTimestamp(o, 'effectiveFrom'),
    effectiveTo: optionalIsoTimestamp(o, 'effectiveTo') ?? null,
  };
}

function requireStayDate(obj: Record<string, unknown>): string {
  const v = requireString(obj, 'stayDate');
  if (!ISO_DATE_RE.test(v) || Number.isNaN(Date.parse(v))) {
    throw new BadRequestException(
      'stayDate must be an ISO 8601 date (YYYY-MM-DD)',
    );
  }
  return v;
}

function parseBoolean(raw: string | undefined, label: string): boolean {
  if (raw === undefined) return false;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new BadRequestException(
    `${label} must be "true" or "false" when present`,
  );
}
