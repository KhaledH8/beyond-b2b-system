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
  requireIsoTimestamp,
  requireUlid,
  requireUlidQuery,
} from './validation';
import {
  DirectContractsService,
  type CreateContractCancellationPolicyInput,
  type CreateSupplierCancellationPolicyInput,
} from './direct-contracts.service';
import type { CancellationPolicyAdminRow } from './cancellation-policy.repository';

/**
 * Contract-scoped cancellation policies surface.
 *
 * Mutation is limited to create + supersede (ADR-023 D8). Supersede
 * is exposed at `POST .../:id/supersede` with the same body shape as
 * create — the repository computes the new `policy_version` from the
 * scope's current MAX inside the transaction.
 */
@UseGuards(InternalAuthGuard)
@Controller(
  'internal/admin/direct-contracts/contracts/:contractId/cancellation-policies',
)
export class ContractCancellationPolicyAdminController {
  constructor(
    @Inject(DirectContractsService)
    private readonly service: DirectContractsService,
  ) {}

  @Post()
  async create(
    @Param('contractId') contractId: string,
    @Body() body: unknown,
    @Actor() actor: InternalActor,
  ): Promise<CancellationPolicyAdminRow> {
    return this.service.createContractCancellationPolicy(
      parseContractCreate(contractId, body),
      actor.actorId,
    );
  }

  @Get()
  async list(
    @Param('contractId') contractId: string,
    @Query('tenantId') tenantIdRaw: string,
    @Query('includeSuperseded') includeSupersededRaw?: string,
  ): Promise<{
    count: number;
    items: ReadonlyArray<CancellationPolicyAdminRow>;
  }> {
    const tenantId = requireUlidQuery(tenantIdRaw, 'tenantId');
    const includeSuperseded = parseBoolean(
      includeSupersededRaw,
      'includeSuperseded',
    );
    const items = await this.service.listContractCancellationPolicies(
      contractId,
      tenantId,
      { includeSuperseded },
    );
    return { count: items.length, items };
  }

  @Get(':id')
  async getOne(
    @Param('contractId') contractId: string,
    @Param('id') id: string,
    @Query('tenantId') tenantIdRaw: string,
  ): Promise<CancellationPolicyAdminRow> {
    const tenantId = requireUlidQuery(tenantIdRaw, 'tenantId');
    const row = await this.service.findContractCancellationPolicyById(
      contractId,
      tenantId,
      id,
    );
    if (!row) {
      throw new NotFoundException(`cancellation policy ${id} not found`);
    }
    return row;
  }

  @Post(':id/supersede')
  async supersede(
    @Param('contractId') contractId: string,
    @Param('id') id: string,
    @Query('tenantId') tenantIdRaw: string,
    @Body() body: unknown,
    @Actor() actor: InternalActor,
  ): Promise<CancellationPolicyAdminRow> {
    const tenantId = requireUlidQuery(tenantIdRaw, 'tenantId');
    return this.service.supersedeContractCancellationPolicy(
      contractId,
      tenantId,
      id,
      parseContractCreate(contractId, body),
      actor.actorId,
    );
  }
}

/**
 * Supplier-default cancellation policies surface (`contract_id IS NULL`).
 *
 * Same uniform shape as the contract-scoped surface (no
 * channel-manager-specific carve-outs as for restrictions). Requires
 * `source_type = 'DIRECT'` via the service guard so the surface stays
 * inside the direct-contracts module's mental model.
 */
@UseGuards(InternalAuthGuard)
@Controller('internal/admin/direct-contracts/supplier-cancellation-policies')
export class SupplierCancellationPolicyAdminController {
  constructor(
    @Inject(DirectContractsService)
    private readonly service: DirectContractsService,
  ) {}

  @Post()
  async create(
    @Body() body: unknown,
    @Actor() actor: InternalActor,
  ): Promise<CancellationPolicyAdminRow> {
    return this.service.createSupplierCancellationPolicy(
      parseSupplierCreate(body),
      actor.actorId,
    );
  }

  @Get()
  async list(
    @Query('tenantId') tenantIdRaw: string,
    @Query('supplierId') supplierIdRaw: string,
    @Query('canonicalHotelId') canonicalHotelIdRaw: string,
    @Query('ratePlanId') ratePlanIdRaw?: string,
    @Query('includeSuperseded') includeSupersededRaw?: string,
  ): Promise<{
    count: number;
    items: ReadonlyArray<CancellationPolicyAdminRow>;
  }> {
    const tenantId = requireUlidQuery(tenantIdRaw, 'tenantId');
    const supplierId = requireUlidQuery(supplierIdRaw, 'supplierId');
    const canonicalHotelId = requireUlidQuery(
      canonicalHotelIdRaw,
      'canonicalHotelId',
    );
    const ratePlanId = ratePlanIdRaw
      ? requireUlidQuery(ratePlanIdRaw, 'ratePlanId')
      : undefined;
    const includeSuperseded = parseBoolean(
      includeSupersededRaw,
      'includeSuperseded',
    );
    const items = await this.service.listSupplierCancellationPolicies({
      tenantId,
      supplierId,
      canonicalHotelId,
      ...(ratePlanId !== undefined ? { ratePlanId } : {}),
      includeSuperseded,
    });
    return { count: items.length, items };
  }

  @Get(':id')
  async getOne(
    @Param('id') id: string,
    @Query('tenantId') tenantIdRaw: string,
  ): Promise<CancellationPolicyAdminRow> {
    const tenantId = requireUlidQuery(tenantIdRaw, 'tenantId');
    const row = await this.service.findSupplierCancellationPolicyById(
      tenantId,
      id,
    );
    if (!row) {
      throw new NotFoundException(`cancellation policy ${id} not found`);
    }
    return row;
  }

  @Post(':id/supersede')
  async supersede(
    @Param('id') id: string,
    @Query('tenantId') tenantIdRaw: string,
    @Body() body: unknown,
    @Actor() actor: InternalActor,
  ): Promise<CancellationPolicyAdminRow> {
    const tenantId = requireUlidQuery(tenantIdRaw, 'tenantId');
    return this.service.supersedeSupplierCancellationPolicy(
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
): CreateContractCancellationPolicyInput {
  const o = asObject(body);
  rejectExtraKeys(o, [
    'tenantId',
    'supplierId',
    'canonicalHotelId',
    'ratePlanId',
    'windowsJsonb',
    'refundable',
    'effectiveFrom',
    'effectiveTo',
  ]);
  return {
    contractId,
    tenantId: requireUlid(o, 'tenantId'),
    supplierId: requireUlid(o, 'supplierId'),
    canonicalHotelId: requireUlid(o, 'canonicalHotelId'),
    ratePlanId: optionalUlid(o, 'ratePlanId') ?? null,
    windowsJsonb: requireWindows(o),
    refundable: requireBoolean(o, 'refundable'),
    effectiveFrom: requireIsoTimestamp(o, 'effectiveFrom'),
    effectiveTo: optionalIsoTimestamp(o, 'effectiveTo') ?? null,
  };
}

function parseSupplierCreate(
  body: unknown,
): CreateSupplierCancellationPolicyInput {
  const o = asObject(body);
  rejectExtraKeys(o, [
    'tenantId',
    'supplierId',
    'canonicalHotelId',
    'ratePlanId',
    'windowsJsonb',
    'refundable',
    'effectiveFrom',
    'effectiveTo',
  ]);
  return {
    tenantId: requireUlid(o, 'tenantId'),
    supplierId: requireUlid(o, 'supplierId'),
    canonicalHotelId: requireUlid(o, 'canonicalHotelId'),
    ratePlanId: optionalUlid(o, 'ratePlanId') ?? null,
    windowsJsonb: requireWindows(o),
    refundable: requireBoolean(o, 'refundable'),
    effectiveFrom: requireIsoTimestamp(o, 'effectiveFrom'),
    effectiveTo: optionalIsoTimestamp(o, 'effectiveTo') ?? null,
  };
}

function requireWindows(obj: Record<string, unknown>): ReadonlyArray<unknown> {
  const v = obj['windowsJsonb'];
  if (!Array.isArray(v)) {
    throw new BadRequestException('windowsJsonb must be a JSON array');
  }
  // Structural validation runs in the service so callers get the same
  // error messages whether the path is create or supersede.
  return v;
}

function requireBoolean(obj: Record<string, unknown>, key: string): boolean {
  const v = obj[key];
  if (typeof v !== 'boolean') {
    throw new BadRequestException(`${key} must be a boolean`);
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
