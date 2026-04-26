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
  optionalString,
  rejectExtraKeys,
  requireInt,
  requireString,
  requireUlid,
  requireUlidQuery,
} from './validation';
import {
  DirectContractsService,
  type CreateChildAgeBandInput,
  type PatchChildAgeBandInput,
} from './direct-contracts.service';
import type { ChildAgeBandAdminRow } from './child-age-band.repository';

@UseGuards(InternalAuthGuard)
@Controller(
  'internal/admin/direct-contracts/contracts/:contractId/child-age-bands',
)
export class ChildAgeBandAdminController {
  constructor(
    @Inject(DirectContractsService)
    private readonly service: DirectContractsService,
  ) {}

  @Post()
  async create(
    @Param('contractId') contractId: string,
    @Body() body: unknown,
    @Actor() actor: InternalActor,
  ): Promise<ChildAgeBandAdminRow> {
    return this.service.createChildAgeBand(
      parseCreate(contractId, body),
      actor.actorId,
    );
  }

  @Get()
  async list(
    @Param('contractId') contractId: string,
    @Query('tenantId') tenantIdRaw: string,
  ): Promise<{ count: number; items: ReadonlyArray<ChildAgeBandAdminRow> }> {
    const tenantId = requireUlidQuery(tenantIdRaw, 'tenantId');
    const items = await this.service.listChildAgeBands(contractId, tenantId);
    return { count: items.length, items };
  }

  @Get(':id')
  async getOne(
    @Param('contractId') contractId: string,
    @Param('id') id: string,
    @Query('tenantId') tenantIdRaw: string,
  ): Promise<ChildAgeBandAdminRow> {
    const tenantId = requireUlidQuery(tenantIdRaw, 'tenantId');
    const row = await this.service.findChildAgeBandById(
      contractId,
      tenantId,
      id,
    );
    if (!row) throw new NotFoundException(`child age band ${id} not found`);
    return row;
  }

  @Patch(':id')
  async patch(
    @Param('contractId') contractId: string,
    @Param('id') id: string,
    @Query('tenantId') tenantIdRaw: string,
    @Body() body: unknown,
    @Actor() actor: InternalActor,
  ): Promise<ChildAgeBandAdminRow> {
    const tenantId = requireUlidQuery(tenantIdRaw, 'tenantId');
    return this.service.patchChildAgeBand(
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
    return this.service.deleteChildAgeBand(
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
): CreateChildAgeBandInput {
  const o = asObject(body);
  rejectExtraKeys(o, ['tenantId', 'name', 'ageMin', 'ageMax']);
  const tenantId = requireUlid(o, 'tenantId');
  const name = requireString(o, 'name');
  const ageMin = requireInt(o, 'ageMin', { min: 0, max: 17 });
  const ageMax = requireInt(o, 'ageMax', { min: 0, max: 17 });
  if (ageMax < ageMin) {
    throw new BadRequestException('ageMax must be >= ageMin');
  }
  return { contractId, tenantId, name, ageMin, ageMax };
}

function parsePatch(body: unknown): PatchChildAgeBandInput {
  const o = asObject(body);
  rejectExtraKeys(o, ['name', 'ageMin', 'ageMax']);
  const out: PatchChildAgeBandInput = {};
  const name = optionalString(o, 'name');
  if (name !== undefined) out.name = name;
  const ageMin = optionalInt(o, 'ageMin', { min: 0, max: 17 });
  if (ageMin !== undefined) out.ageMin = ageMin;
  const ageMax = optionalInt(o, 'ageMax', { min: 0, max: 17 });
  if (ageMax !== undefined) out.ageMax = ageMax;
  return out;
}
