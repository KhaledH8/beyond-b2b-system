import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { InternalAuthGuard } from '../internal-auth/internal-auth.guard';
import { Actor } from '../internal-auth/actor.decorator';
import type { InternalActor } from '../internal-auth/internal-actor';
import {
  asObject,
  optionalInt,
  optionalUlid,
  rejectExtraKeys,
  requireEnum,
  requireInt,
  requireUlid,
  requireUlidQuery,
} from './validation';
import {
  DirectContractsService,
  type CreateOccupancySupplementInput,
  type PatchOccupancySupplementInput,
} from './direct-contracts.service';
import type { OccupancySupplementAdminRow } from './occupancy-supplement.repository';

const ENUM_OCCUPANT_KIND_OCC = new Set<'EXTRA_ADULT' | 'EXTRA_CHILD'>([
  'EXTRA_ADULT',
  'EXTRA_CHILD',
]);

@UseGuards(InternalAuthGuard)
@Controller(
  'internal/admin/direct-contracts/contracts/:contractId/occupancy-supplements',
)
export class OccupancySupplementAdminController {
  constructor(
    @Inject(DirectContractsService)
    private readonly service: DirectContractsService,
  ) {}

  @Post()
  async create(
    @Param('contractId') contractId: string,
    @Body() body: unknown,
    @Actor() actor: InternalActor,
  ): Promise<OccupancySupplementAdminRow> {
    return this.service.createOccupancySupplement(
      parseCreate(contractId, body),
      actor.actorId,
    );
  }

  @Get()
  async list(
    @Param('contractId') contractId: string,
    @Query('tenantId') tenantIdRaw: string,
    @Query('seasonId') seasonIdRaw?: string,
  ): Promise<{
    count: number;
    items: ReadonlyArray<OccupancySupplementAdminRow>;
  }> {
    const tenantId = requireUlidQuery(tenantIdRaw, 'tenantId');
    const seasonId = seasonIdRaw
      ? requireUlidQuery(seasonIdRaw, 'seasonId')
      : undefined;
    const items = await this.service.listOccupancySupplements(
      contractId,
      tenantId,
      seasonId,
    );
    return { count: items.length, items };
  }

  @Get(':id')
  async getOne(
    @Param('contractId') contractId: string,
    @Param('id') id: string,
    @Query('tenantId') tenantIdRaw: string,
  ): Promise<OccupancySupplementAdminRow> {
    const tenantId = requireUlidQuery(tenantIdRaw, 'tenantId');
    const row = await this.service.findOccupancySupplementById(
      contractId,
      tenantId,
      id,
    );
    if (!row) throw new NotFoundException(`occupancy supplement ${id} not found`);
    return row;
  }

  @Patch(':id')
  async patch(
    @Param('contractId') contractId: string,
    @Param('id') id: string,
    @Query('tenantId') tenantIdRaw: string,
    @Body() body: unknown,
    @Actor() actor: InternalActor,
  ): Promise<OccupancySupplementAdminRow> {
    const tenantId = requireUlidQuery(tenantIdRaw, 'tenantId');
    return this.service.patchOccupancySupplement(
      contractId,
      tenantId,
      id,
      parsePatch(body),
      actor.actorId,
    );
  }

  @Delete(':id')
  @HttpCode(204)
  async delete(
    @Param('contractId') contractId: string,
    @Param('id') id: string,
    @Query('tenantId') tenantIdRaw: string,
    @Actor() actor: InternalActor,
  ): Promise<void> {
    const tenantId = requireUlidQuery(tenantIdRaw, 'tenantId');
    return this.service.deleteOccupancySupplement(
      contractId,
      tenantId,
      id,
      actor.actorId,
    );
  }
}

// ---------------------------------------------------------------------------
// Body parsers
// ---------------------------------------------------------------------------

function parseCreate(
  contractId: string,
  body: unknown,
): CreateOccupancySupplementInput {
  const o = asObject(body);
  rejectExtraKeys(o, [
    'tenantId',
    'seasonId',
    'roomTypeId',
    'ratePlanId',
    'occupantKind',
    'childAgeBandId',
    'slotIndex',
    'amountMinorUnits',
  ]);
  const tenantId = requireUlid(o, 'tenantId');
  const seasonId = requireUlid(o, 'seasonId');
  const roomTypeId = requireUlid(o, 'roomTypeId');
  const ratePlanId = requireUlid(o, 'ratePlanId');
  const occupantKind = requireEnum(o, 'occupantKind', ENUM_OCCUPANT_KIND_OCC);
  const childAgeBandId = optionalUlid(o, 'childAgeBandId') ?? null;
  const slotIndex = optionalInt(o, 'slotIndex', { min: 1 }) ?? 1;
  const amountMinorUnits = requireInt(o, 'amountMinorUnits', { min: 0 });

  if (occupantKind === 'EXTRA_CHILD' && !childAgeBandId) {
    throw new BadRequestException(
      'childAgeBandId is required for EXTRA_CHILD supplements',
    );
  }
  if (occupantKind === 'EXTRA_ADULT' && childAgeBandId) {
    throw new BadRequestException(
      'childAgeBandId must not be set for EXTRA_ADULT supplements',
    );
  }

  return {
    contractId,
    tenantId,
    seasonId,
    roomTypeId,
    ratePlanId,
    occupantKind,
    childAgeBandId,
    slotIndex,
    amountMinorUnits,
  };
}

function parsePatch(body: unknown): PatchOccupancySupplementInput {
  const o = asObject(body);
  rejectExtraKeys(o, ['amountMinorUnits']);
  const out: PatchOccupancySupplementInput = {};
  const amountMinorUnits = optionalInt(o, 'amountMinorUnits', { min: 0 });
  if (amountMinorUnits !== undefined) out.amountMinorUnits = amountMinorUnits;
  return out;
}
