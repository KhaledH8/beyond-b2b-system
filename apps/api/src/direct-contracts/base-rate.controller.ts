import {
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
  requireInt,
  requireUlid,
  requireUlidQuery,
  requireCurrency,
} from './validation';
import {
  DirectContractsService,
  type CreateBaseRateInput,
  type PatchBaseRateInput,
} from './direct-contracts.service';
import type { BaseRateAdminRow } from './base-rate.repository';

@UseGuards(InternalAuthGuard)
@Controller(
  'internal/admin/direct-contracts/contracts/:contractId/base-rates',
)
export class BaseRateAdminController {
  constructor(
    @Inject(DirectContractsService)
    private readonly service: DirectContractsService,
  ) {}

  @Post()
  async create(
    @Param('contractId') contractId: string,
    @Body() body: unknown,
    @Actor() actor: InternalActor,
  ): Promise<BaseRateAdminRow> {
    return this.service.createBaseRate(
      parseCreate(contractId, body),
      actor.actorId,
    );
  }

  @Get()
  async list(
    @Param('contractId') contractId: string,
    @Query('tenantId') tenantIdRaw: string,
    @Query('seasonId') seasonIdRaw?: string,
  ): Promise<{ count: number; items: ReadonlyArray<BaseRateAdminRow> }> {
    const tenantId = requireUlidQuery(tenantIdRaw, 'tenantId');
    const seasonId = seasonIdRaw ? requireUlidQuery(seasonIdRaw, 'seasonId') : undefined;
    const items = await this.service.listBaseRates(contractId, tenantId, seasonId);
    return { count: items.length, items };
  }

  @Get(':id')
  async getOne(
    @Param('contractId') contractId: string,
    @Param('id') id: string,
    @Query('tenantId') tenantIdRaw: string,
  ): Promise<BaseRateAdminRow> {
    const tenantId = requireUlidQuery(tenantIdRaw, 'tenantId');
    const row = await this.service.findBaseRateById(contractId, tenantId, id);
    if (!row) throw new NotFoundException(`base rate ${id} not found`);
    return row;
  }

  @Patch(':id')
  async patch(
    @Param('contractId') contractId: string,
    @Param('id') id: string,
    @Query('tenantId') tenantIdRaw: string,
    @Body() body: unknown,
    @Actor() actor: InternalActor,
  ): Promise<BaseRateAdminRow> {
    const tenantId = requireUlidQuery(tenantIdRaw, 'tenantId');
    return this.service.patchBaseRate(
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
    return this.service.deleteBaseRate(contractId, tenantId, id, actor.actorId);
  }
}

// ---------------------------------------------------------------------------
// Body parsers
// ---------------------------------------------------------------------------

function parseCreate(contractId: string, body: unknown): CreateBaseRateInput {
  const o = asObject(body);
  rejectExtraKeys(o, [
    'tenantId',
    'seasonId',
    'roomTypeId',
    'ratePlanId',
    'occupancyTemplateId',
    'includedMealPlanId',
    'amountMinorUnits',
    'currency',
  ]);
  const tenantId = requireUlid(o, 'tenantId');
  const seasonId = requireUlid(o, 'seasonId');
  const roomTypeId = requireUlid(o, 'roomTypeId');
  const ratePlanId = requireUlid(o, 'ratePlanId');
  const occupancyTemplateId = requireUlid(o, 'occupancyTemplateId');
  const includedMealPlanId = requireUlid(o, 'includedMealPlanId');
  const amountMinorUnits = requireInt(o, 'amountMinorUnits', { min: 0 });
  const currency = requireCurrency(o, 'currency');
  return {
    contractId,
    tenantId,
    seasonId,
    roomTypeId,
    ratePlanId,
    occupancyTemplateId,
    includedMealPlanId,
    amountMinorUnits,
    currency,
  };
}

function parsePatch(body: unknown): PatchBaseRateInput {
  const o = asObject(body);
  rejectExtraKeys(o, ['amountMinorUnits', 'includedMealPlanId']);
  const out: PatchBaseRateInput = {};
  const amountMinorUnits = optionalInt(o, 'amountMinorUnits', { min: 0 });
  if (amountMinorUnits !== undefined) out.amountMinorUnits = amountMinorUnits;
  const includedMealPlanId = optionalUlid(o, 'includedMealPlanId');
  if (includedMealPlanId !== undefined) out.includedMealPlanId = includedMealPlanId;
  return out;
}
