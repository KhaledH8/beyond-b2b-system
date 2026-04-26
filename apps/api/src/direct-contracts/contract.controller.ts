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
import { Actor } from '../internal-auth/actor.decorator';
import type { InternalActor } from '../internal-auth/internal-actor';
import {
  asObject,
  optionalIsoDate,
  optionalString,
  optionalUlid,
  rejectExtraKeys,
  requireCurrency,
  requireString,
  requireUlid,
  requireUlidQuery,
  ENUM_CONTRACT_LIST_STATUS,
  ENUM_CONTRACT_PATCH_STATUS,
  optionalEnum,
} from './validation';
import {
  DirectContractsService,
  type CreateContractInput,
  type PatchContractInput,
} from './direct-contracts.service';
import type { ContractAdminRow } from './contract.repository';

@UseGuards(InternalAuthGuard)
@Controller('internal/admin/direct-contracts/contracts')
export class ContractAdminController {
  constructor(
    @Inject(DirectContractsService)
    private readonly service: DirectContractsService,
  ) {}

  @Post()
  async create(
    @Body() body: unknown,
    @Actor() actor: InternalActor,
  ): Promise<ContractAdminRow> {
    return this.service.createContract(parseCreate(body), actor.actorId);
  }

  @Get()
  async list(
    @Query() query: Record<string, string>,
  ): Promise<{ count: number; items: ReadonlyArray<ContractAdminRow> }> {
    const filter = parseListFilter(query);
    const items = await this.service.listContracts(filter);
    return { count: items.length, items };
  }

  @Get(':id')
  async getOne(
    @Param('id') id: string,
    @Query('tenantId') tenantIdRaw: string,
  ): Promise<ContractAdminRow> {
    const tenantId = requireUlidQuery(tenantIdRaw, 'tenantId');
    const row = await this.service.findContractById(id, tenantId);
    if (!row) throw new NotFoundException(`contract ${id} not found`);
    return row;
  }

  @Patch(':id')
  async patch(
    @Param('id') id: string,
    @Query('tenantId') tenantIdRaw: string,
    @Body() body: unknown,
    @Actor() actor: InternalActor,
  ): Promise<ContractAdminRow> {
    const tenantId = requireUlidQuery(tenantIdRaw, 'tenantId');
    return this.service.patchContract(
      id,
      tenantId,
      parsePatch(body),
      actor.actorId,
    );
  }

  @Delete(':id')
  async softDelete(
    @Param('id') id: string,
    @Query('tenantId') tenantIdRaw: string,
    @Actor() actor: InternalActor,
  ): Promise<ContractAdminRow> {
    const tenantId = requireUlidQuery(tenantIdRaw, 'tenantId');
    return this.service.softDeleteContract(id, tenantId, actor.actorId);
  }
}

// ---------------------------------------------------------------------------
// Body / query parsers
// ---------------------------------------------------------------------------

function parseCreate(body: unknown): CreateContractInput {
  const o = asObject(body);
  rejectExtraKeys(o, [
    'tenantId',
    'canonicalHotelId',
    'supplierId',
    'contractCode',
    'currency',
    'validFrom',
    'validTo',
    'parentContractId',
    'signedDocRef',
    'notes',
  ]);
  const tenantId = requireUlid(o, 'tenantId');
  const canonicalHotelId = requireUlid(o, 'canonicalHotelId');
  const supplierId = requireUlid(o, 'supplierId');
  const contractCode = requireString(o, 'contractCode');
  if (contractCode.length > 64) {
    throw new Error('contractCode must be at most 64 characters');
  }
  const currency = requireCurrency(o, 'currency');
  const out: CreateContractInput = {
    tenantId,
    canonicalHotelId,
    supplierId,
    contractCode,
    currency,
  };
  const validFrom = optionalIsoDate(o, 'validFrom');
  if (validFrom !== undefined) out.validFrom = validFrom;
  const validTo = optionalIsoDate(o, 'validTo');
  if (validTo !== undefined) out.validTo = validTo;
  const parentContractId = optionalUlid(o, 'parentContractId');
  if (parentContractId !== undefined) out.parentContractId = parentContractId;
  const signedDocRef = optionalString(o, 'signedDocRef');
  if (signedDocRef !== undefined) out.signedDocRef = signedDocRef;
  const notes = optionalString(o, 'notes');
  if (notes !== undefined) out.notes = notes;
  return out;
}

function parsePatch(body: unknown): PatchContractInput {
  const o = asObject(body);
  rejectExtraKeys(o, [
    'contractCode',
    'currency',
    'validFrom',
    'validTo',
    'status',
    'signedDocRef',
    'notes',
  ]);
  const out: PatchContractInput = {};
  const contractCode = optionalString(o, 'contractCode');
  if (contractCode !== undefined) {
    if (contractCode.length > 64) {
      throw new Error('contractCode must be at most 64 characters');
    }
    out.contractCode = contractCode;
  }
  if (o['currency'] !== undefined && o['currency'] !== null) {
    out.currency = requireCurrency(o, 'currency');
  }
  if (Object.prototype.hasOwnProperty.call(o, 'validFrom')) {
    out.validFrom = optionalIsoDate(o, 'validFrom') ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(o, 'validTo')) {
    out.validTo = optionalIsoDate(o, 'validTo') ?? null;
  }
  const status = optionalEnum<'ACTIVE' | 'INACTIVE'>(
    o,
    'status',
    ENUM_CONTRACT_PATCH_STATUS,
  );
  if (status !== undefined) out.status = status;
  if (Object.prototype.hasOwnProperty.call(o, 'signedDocRef')) {
    out.signedDocRef = optionalString(o, 'signedDocRef') ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(o, 'notes')) {
    out.notes = optionalString(o, 'notes') ?? null;
  }
  return out;
}

function parseListFilter(
  query: Record<string, string>,
): Parameters<DirectContractsService['listContracts']>[0] {
  const o = query as Record<string, unknown>;
  const tenantId = requireUlid(o, 'tenantId');
  const filter: Parameters<DirectContractsService['listContracts']>[0] = {
    tenantId,
  };
  const canonicalHotelId = optionalUlid(o, 'canonicalHotelId');
  if (canonicalHotelId !== undefined) filter.canonicalHotelId = canonicalHotelId;
  const status = optionalEnum<'DRAFT' | 'ACTIVE' | 'INACTIVE'>(
    o,
    'status',
    ENUM_CONTRACT_LIST_STATUS,
  );
  if (status !== undefined) filter.status = status;
  const limitRaw = optionalString(o, 'limit');
  if (limitRaw !== undefined) {
    const n = Number.parseInt(limitRaw, 10);
    if (Number.isInteger(n) && n >= 1 && n <= 1000) filter.limit = n;
  }
  const offsetRaw = optionalString(o, 'offset');
  if (offsetRaw !== undefined) {
    const n = Number.parseInt(offsetRaw, 10);
    if (Number.isInteger(n) && n >= 0) filter.offset = n;
  }
  return filter;
}

