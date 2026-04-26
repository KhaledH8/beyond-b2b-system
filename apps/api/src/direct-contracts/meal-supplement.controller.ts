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
  type CreateMealSupplementInput,
  type PatchMealSupplementInput,
} from './direct-contracts.service';
import type { MealSupplementAdminRow } from './meal-supplement.repository';

const ENUM_OCCUPANT_KIND_MEAL = new Set<'ADULT' | 'CHILD'>([
  'ADULT',
  'CHILD',
]);

@UseGuards(InternalAuthGuard)
@Controller(
  'internal/admin/direct-contracts/contracts/:contractId/meal-supplements',
)
export class MealSupplementAdminController {
  constructor(
    @Inject(DirectContractsService)
    private readonly service: DirectContractsService,
  ) {}

  @Post()
  async create(
    @Param('contractId') contractId: string,
    @Body() body: unknown,
    @Actor() actor: InternalActor,
  ): Promise<MealSupplementAdminRow> {
    return this.service.createMealSupplement(
      parseCreate(contractId, body),
      actor.actorId,
    );
  }

  @Get()
  async list(
    @Param('contractId') contractId: string,
    @Query('tenantId') tenantIdRaw: string,
    @Query('seasonId') seasonIdRaw?: string,
  ): Promise<{ count: number; items: ReadonlyArray<MealSupplementAdminRow> }> {
    const tenantId = requireUlidQuery(tenantIdRaw, 'tenantId');
    const seasonId = seasonIdRaw
      ? requireUlidQuery(seasonIdRaw, 'seasonId')
      : undefined;
    const items = await this.service.listMealSupplements(
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
  ): Promise<MealSupplementAdminRow> {
    const tenantId = requireUlidQuery(tenantIdRaw, 'tenantId');
    const row = await this.service.findMealSupplementById(
      contractId,
      tenantId,
      id,
    );
    if (!row) throw new NotFoundException(`meal supplement ${id} not found`);
    return row;
  }

  @Patch(':id')
  async patch(
    @Param('contractId') contractId: string,
    @Param('id') id: string,
    @Query('tenantId') tenantIdRaw: string,
    @Body() body: unknown,
    @Actor() actor: InternalActor,
  ): Promise<MealSupplementAdminRow> {
    const tenantId = requireUlidQuery(tenantIdRaw, 'tenantId');
    return this.service.patchMealSupplement(
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
    return this.service.deleteMealSupplement(
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
): CreateMealSupplementInput {
  const o = asObject(body);
  rejectExtraKeys(o, [
    'tenantId',
    'seasonId',
    'roomTypeId',
    'ratePlanId',
    'targetMealPlanId',
    'occupantKind',
    'childAgeBandId',
    'amountMinorUnits',
  ]);
  const tenantId = requireUlid(o, 'tenantId');
  const seasonId = requireUlid(o, 'seasonId');
  const roomTypeId = optionalUlid(o, 'roomTypeId') ?? null;
  const ratePlanId = optionalUlid(o, 'ratePlanId') ?? null;
  const targetMealPlanId = requireUlid(o, 'targetMealPlanId');
  const occupantKind = requireEnum(o, 'occupantKind', ENUM_OCCUPANT_KIND_MEAL);
  const childAgeBandId = optionalUlid(o, 'childAgeBandId') ?? null;
  const amountMinorUnits = requireInt(o, 'amountMinorUnits', { min: 0 });

  if (occupantKind === 'CHILD' && !childAgeBandId) {
    throw new BadRequestException(
      'childAgeBandId is required for CHILD meal supplements',
    );
  }
  if (occupantKind === 'ADULT' && childAgeBandId) {
    throw new BadRequestException(
      'childAgeBandId must not be set for ADULT meal supplements',
    );
  }

  return {
    contractId,
    tenantId,
    seasonId,
    roomTypeId,
    ratePlanId,
    targetMealPlanId,
    occupantKind,
    childAgeBandId,
    amountMinorUnits,
  };
}

function parsePatch(body: unknown): PatchMealSupplementInput {
  const o = asObject(body);
  rejectExtraKeys(o, ['amountMinorUnits']);
  const out: PatchMealSupplementInput = {};
  const amountMinorUnits = optionalInt(o, 'amountMinorUnits', { min: 0 });
  if (amountMinorUnits !== undefined) out.amountMinorUnits = amountMinorUnits;
  return out;
}
