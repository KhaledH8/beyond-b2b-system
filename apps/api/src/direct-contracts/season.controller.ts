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
  optionalIsoDate,
  optionalString,
  rejectExtraKeys,
  requireIsoDate,
  requireString,
  requireUlid,
  requireUlidQuery,
} from './validation';
import {
  DirectContractsService,
  type CreateSeasonInput,
  type PatchSeasonInput,
} from './direct-contracts.service';
import type { SeasonAdminRow } from './season.repository';

@UseGuards(InternalAuthGuard)
@Controller(
  'internal/admin/direct-contracts/contracts/:contractId/seasons',
)
export class SeasonAdminController {
  constructor(
    @Inject(DirectContractsService)
    private readonly service: DirectContractsService,
  ) {}

  @Post()
  async create(
    @Param('contractId') contractId: string,
    @Body() body: unknown,
    @Actor() actor: InternalActor,
  ): Promise<SeasonAdminRow> {
    return this.service.createSeason(
      parseCreate(contractId, body),
      actor.actorId,
    );
  }

  @Get()
  async list(
    @Param('contractId') contractId: string,
    @Query('tenantId') tenantIdRaw: string,
  ): Promise<{ count: number; items: ReadonlyArray<SeasonAdminRow> }> {
    const tenantId = requireUlidQuery(tenantIdRaw, 'tenantId');
    const items = await this.service.listSeasons(contractId, tenantId);
    return { count: items.length, items };
  }

  @Get(':id')
  async getOne(
    @Param('contractId') contractId: string,
    @Param('id') id: string,
    @Query('tenantId') tenantIdRaw: string,
  ): Promise<SeasonAdminRow> {
    const tenantId = requireUlidQuery(tenantIdRaw, 'tenantId');
    const row = await this.service.findSeasonById(contractId, tenantId, id);
    if (!row) throw new NotFoundException(`season ${id} not found`);
    return row;
  }

  @Patch(':id')
  async patch(
    @Param('contractId') contractId: string,
    @Param('id') id: string,
    @Query('tenantId') tenantIdRaw: string,
    @Body() body: unknown,
    @Actor() actor: InternalActor,
  ): Promise<SeasonAdminRow> {
    const tenantId = requireUlidQuery(tenantIdRaw, 'tenantId');
    return this.service.patchSeason(
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
    return this.service.deleteSeason(contractId, tenantId, id, actor.actorId);
  }
}

// ---------------------------------------------------------------------------
// Body parsers
// ---------------------------------------------------------------------------

function parseCreate(
  contractId: string,
  body: unknown,
): CreateSeasonInput {
  const o = asObject(body);
  rejectExtraKeys(o, ['tenantId', 'name', 'dateFrom', 'dateTo']);
  const tenantId = requireUlid(o, 'tenantId');
  const name = requireString(o, 'name');
  const dateFrom = requireIsoDate(o, 'dateFrom');
  const dateTo = requireIsoDate(o, 'dateTo');
  return { contractId, tenantId, name, dateFrom, dateTo };
}

function parsePatch(body: unknown): PatchSeasonInput {
  const o = asObject(body);
  rejectExtraKeys(o, ['name', 'dateFrom', 'dateTo']);
  const out: PatchSeasonInput = {};
  const name = optionalString(o, 'name');
  if (name !== undefined) out.name = name;
  const dateFrom = optionalIsoDate(o, 'dateFrom');
  if (dateFrom !== undefined) out.dateFrom = dateFrom;
  const dateTo = optionalIsoDate(o, 'dateTo');
  if (dateTo !== undefined) out.dateTo = dateTo;
  return out;
}
