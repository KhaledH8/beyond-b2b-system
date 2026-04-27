import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Pool, PoolClient } from '@bb/db';
import { PG_POOL } from '../database/database.module';
import { newUlid } from '../common/ulid';
import { AuditLogRepository } from '../admin/audit-log.repository';
import { ContractRepository, type ContractAdminRow } from './contract.repository';
import { SeasonRepository, type SeasonAdminRow } from './season.repository';
import {
  ChildAgeBandRepository,
  type ChildAgeBandAdminRow,
} from './child-age-band.repository';
import {
  BaseRateRepository,
  type BaseRateAdminRow,
} from './base-rate.repository';
import {
  OccupancySupplementRepository,
  type OccupancySupplementAdminRow,
} from './occupancy-supplement.repository';
import {
  MealSupplementRepository,
  type MealSupplementAdminRow,
} from './meal-supplement.repository';
import {
  RestrictionRepository,
  type RestrictionAdminRow,
} from './restriction.repository';
import {
  RESTRICTION_KINDS_FORBIDDEN_FOR_CONTRACT_SCOPED,
  validateRestrictionParams,
  type RestrictionKind,
} from './validation';

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface CreateContractInput {
  tenantId: string;
  canonicalHotelId: string;
  supplierId: string;
  contractCode: string;
  currency: string;
  validFrom?: string;
  validTo?: string;
  parentContractId?: string;
  signedDocRef?: string;
  notes?: string;
}

export interface PatchContractInput {
  contractCode?: string;
  currency?: string;
  validFrom?: string | null;
  validTo?: string | null;
  status?: 'ACTIVE' | 'INACTIVE';
  signedDocRef?: string | null;
  notes?: string | null;
}

export interface CreateSeasonInput {
  contractId: string;
  tenantId: string;
  name: string;
  dateFrom: string;
  dateTo: string;
}

export interface PatchSeasonInput {
  name?: string;
  dateFrom?: string;
  dateTo?: string;
}

export interface CreateChildAgeBandInput {
  contractId: string;
  tenantId: string;
  name: string;
  ageMin: number;
  ageMax: number;
}

export interface PatchChildAgeBandInput {
  name?: string;
  ageMin?: number;
  ageMax?: number;
}

export interface CreateBaseRateInput {
  contractId: string;
  tenantId: string;
  seasonId: string;
  roomTypeId: string;
  ratePlanId: string;
  occupancyTemplateId: string;
  includedMealPlanId: string;
  amountMinorUnits: number;
  currency: string;
}

export interface PatchBaseRateInput {
  amountMinorUnits?: number;
  includedMealPlanId?: string;
}

export interface CreateOccupancySupplementInput {
  contractId: string;
  tenantId: string;
  seasonId: string;
  roomTypeId: string;
  ratePlanId: string;
  occupantKind: 'EXTRA_ADULT' | 'EXTRA_CHILD';
  childAgeBandId: string | null;
  slotIndex: number;
  amountMinorUnits: number;
}

export interface PatchOccupancySupplementInput {
  amountMinorUnits?: number;
}

export interface CreateMealSupplementInput {
  contractId: string;
  tenantId: string;
  seasonId: string;
  roomTypeId: string | null;
  ratePlanId: string | null;
  targetMealPlanId: string;
  occupantKind: 'ADULT' | 'CHILD';
  childAgeBandId: string | null;
  amountMinorUnits: number;
}

export interface PatchMealSupplementInput {
  amountMinorUnits?: number;
}

export interface CreateContractRestrictionInput {
  contractId: string;
  tenantId: string;
  supplierId: string;
  canonicalHotelId: string;
  ratePlanId: string | null;
  roomTypeId: string | null;
  seasonId: string | null;
  stayDate: string;
  restrictionKind: RestrictionKind;
  params: Record<string, unknown>;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface CreateSupplierRestrictionInput {
  tenantId: string;
  supplierId: string;
  canonicalHotelId: string;
  ratePlanId: string | null;
  roomTypeId: string | null;
  stayDate: string;
  restrictionKind: RestrictionKind;
  params: Record<string, unknown>;
  effectiveFrom: string;
  effectiveTo: string | null;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class DirectContractsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(ContractRepository)
    private readonly contractRepo: ContractRepository,
    @Inject(SeasonRepository) private readonly seasonRepo: SeasonRepository,
    @Inject(ChildAgeBandRepository)
    private readonly bandRepo: ChildAgeBandRepository,
    @Inject(AuditLogRepository) private readonly audit: AuditLogRepository,
    @Inject(BaseRateRepository)
    private readonly baseRateRepo: BaseRateRepository,
    @Inject(OccupancySupplementRepository)
    private readonly occSuppRepo: OccupancySupplementRepository,
    @Inject(MealSupplementRepository)
    private readonly mealSuppRepo: MealSupplementRepository,
    @Inject(RestrictionRepository)
    private readonly restrictionRepo: RestrictionRepository,
  ) {}

  // ---- contracts -----------------------------------------------------------

  async createContract(
    input: CreateContractInput,
    actorId: string,
  ): Promise<ContractAdminRow> {
    await this.requireDirectSupplier(input.supplierId);
    requireDateOrder(input.validFrom, input.validTo);

    const row = await this.contractRepo.insert({
      id: newUlid(),
      tenantId: input.tenantId,
      canonicalHotelId: input.canonicalHotelId,
      supplierId: input.supplierId,
      contractCode: input.contractCode,
      currency: input.currency,
      ...(input.validFrom !== undefined ? { validFrom: input.validFrom } : {}),
      ...(input.validTo !== undefined ? { validTo: input.validTo } : {}),
      ...(input.parentContractId !== undefined
        ? { parentContractId: input.parentContractId }
        : {}),
      ...(input.signedDocRef !== undefined
        ? { signedDocRef: input.signedDocRef }
        : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    });
    await this.audit.write({
      tenantId: input.tenantId,
      actorId,
      resourceType: 'direct_contract',
      resourceId: row.id,
      operation: 'CREATE',
      payload: input as unknown as Record<string, unknown>,
    });
    return row;
  }

  async patchContract(
    id: string,
    tenantId: string,
    patch: PatchContractInput,
    actorId: string,
  ): Promise<ContractAdminRow> {
    const existing = await this.contractRepo.findById(id, tenantId);
    if (!existing) throw new NotFoundException(`contract ${id} not found`);

    if (existing.status === 'INACTIVE') {
      throw new BadRequestException('INACTIVE contracts cannot be modified');
    }

    if (patch.status === 'ACTIVE' && existing.status !== 'ACTIVE') {
      const seasonCount = await this.seasonRepo.count(id);
      if (seasonCount === 0) {
        throw new BadRequestException(
          'contract cannot be activated until at least one season is defined',
        );
      }
    }

    if (patch.validFrom !== undefined || patch.validTo !== undefined) {
      const nextFrom =
        patch.validFrom !== undefined ? patch.validFrom : existing.validFrom;
      const nextTo =
        patch.validTo !== undefined ? patch.validTo : existing.validTo;
      requireDateOrder(nextFrom ?? undefined, nextTo ?? undefined);
    }

    const row = await this.contractRepo.patch(id, tenantId, patch);
    await this.audit.write({
      tenantId,
      actorId,
      resourceType: 'direct_contract',
      resourceId: id,
      operation: 'PATCH',
      payload: patch as unknown as Record<string, unknown>,
    });
    return row;
  }

  async softDeleteContract(
    id: string,
    tenantId: string,
    actorId: string,
  ): Promise<ContractAdminRow> {
    const existing = await this.contractRepo.findById(id, tenantId);
    if (!existing) throw new NotFoundException(`contract ${id} not found`);
    if (existing.status === 'INACTIVE') {
      throw new BadRequestException('contract is already INACTIVE');
    }
    const row = await this.contractRepo.patch(id, tenantId, {
      status: 'INACTIVE',
    });
    await this.audit.write({
      tenantId,
      actorId,
      resourceType: 'direct_contract',
      resourceId: id,
      operation: 'SOFT_DELETE',
      payload: {},
    });
    return row;
  }

  findContractById(
    id: string,
    tenantId: string,
  ): Promise<ContractAdminRow | null> {
    return this.contractRepo.findById(id, tenantId);
  }

  listContracts(
    filter: Parameters<ContractRepository['list']>[0],
  ): Promise<ReadonlyArray<ContractAdminRow>> {
    return this.contractRepo.list(filter);
  }

  // ---- seasons -------------------------------------------------------------
  //
  // Season creation uses a serialisable transaction: we lock the contract row
  // FOR UPDATE before the overlap check so concurrent inserts cannot both pass
  // the overlap check and produce overlapping seasons.

  async createSeason(
    input: CreateSeasonInput,
    actorId: string,
  ): Promise<SeasonAdminRow> {
    requireDateOrder(input.dateFrom, input.dateTo);
    let client: PoolClient | null = null;
    let row: SeasonAdminRow;

    try {
      client = await this.pool.connect();
      await client.query('BEGIN');

      const { rows: contractRows } = await client.query<{ status: string }>(
        `SELECT status FROM rate_auth_contract
          WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [input.contractId, input.tenantId],
      );
      if (contractRows.length === 0) {
        throw new NotFoundException(`contract ${input.contractId} not found`);
      }
      if (contractRows[0]!.status === 'INACTIVE') {
        throw new BadRequestException(
          'cannot add seasons to an INACTIVE contract',
        );
      }

      const { rows: overlapRows } = await client.query(
        `SELECT 1 FROM rate_auth_season
          WHERE contract_id = $1
            AND date_from <= $3::date
            AND date_to   >= $2::date`,
        [input.contractId, input.dateFrom, input.dateTo],
      );
      if (overlapRows.length > 0) {
        throw new ConflictException(
          'season dates overlap with an existing season in this contract',
        );
      }

      const id = newUlid();
      const { rows } = await client.query<{
        id: string;
        contract_id: string;
        name: string;
        date_from: string;
        date_to: string;
        created_at: Date;
        updated_at: Date;
      }>(
        `INSERT INTO rate_auth_season (id, contract_id, name, date_from, date_to)
          VALUES ($1, $2, $3, $4::date, $5::date)
          RETURNING *`,
        [id, input.contractId, input.name, input.dateFrom, input.dateTo],
      );

      await client.query('COMMIT');

      const r = rows[0]!;
      row = {
        id: r.id,
        contractId: r.contract_id,
        name: r.name,
        dateFrom: r.date_from,
        dateTo: r.date_to,
        createdAt: r.created_at.toISOString(),
        updatedAt: r.updated_at.toISOString(),
      };
    } catch (err) {
      if (client) await client.query('ROLLBACK');
      throw err;
    } finally {
      if (client) client.release();
    }

    await this.audit.write({
      tenantId: input.tenantId,
      actorId,
      resourceType: 'direct_contract_season',
      resourceId: row.id,
      operation: 'CREATE',
      payload: input as unknown as Record<string, unknown>,
    });
    return row;
  }

  async patchSeason(
    contractId: string,
    tenantId: string,
    seasonId: string,
    patch: PatchSeasonInput,
    actorId: string,
  ): Promise<SeasonAdminRow> {
    const contract = await this.contractRepo.findById(contractId, tenantId);
    if (!contract) throw new NotFoundException(`contract ${contractId} not found`);
    if (contract.status === 'INACTIVE') {
      throw new BadRequestException(
        'cannot modify seasons on an INACTIVE contract',
      );
    }

    if (patch.dateFrom !== undefined || patch.dateTo !== undefined) {
      const existing = await this.seasonRepo.findById(seasonId, contractId);
      if (!existing) throw new NotFoundException(`season ${seasonId} not found`);
      const nextFrom = patch.dateFrom ?? existing.dateFrom;
      const nextTo = patch.dateTo ?? existing.dateTo;
      requireDateOrder(nextFrom, nextTo);
      await this.seasonRepo.assertNoOverlap(contractId, nextFrom, nextTo, seasonId);
    }

    const row = await this.seasonRepo.patch(seasonId, contractId, patch);
    await this.audit.write({
      tenantId,
      actorId,
      resourceType: 'direct_contract_season',
      resourceId: seasonId,
      operation: 'PATCH',
      payload: patch as unknown as Record<string, unknown>,
    });
    return row;
  }

  async deleteSeason(
    contractId: string,
    tenantId: string,
    seasonId: string,
    actorId: string,
  ): Promise<void> {
    const contract = await this.contractRepo.findById(contractId, tenantId);
    if (!contract) throw new NotFoundException(`contract ${contractId} not found`);
    await this.seasonRepo.delete(seasonId, contractId);
    await this.audit.write({
      tenantId,
      actorId,
      resourceType: 'direct_contract_season',
      resourceId: seasonId,
      operation: 'DELETE',
      payload: { contractId },
    });
  }

  async listSeasons(
    contractId: string,
    tenantId: string,
  ): Promise<ReadonlyArray<SeasonAdminRow>> {
    const contract = await this.contractRepo.findById(contractId, tenantId);
    if (!contract) throw new NotFoundException(`contract ${contractId} not found`);
    return this.seasonRepo.list(contractId);
  }

  async findSeasonById(
    contractId: string,
    tenantId: string,
    seasonId: string,
  ): Promise<SeasonAdminRow | null> {
    const contract = await this.contractRepo.findById(contractId, tenantId);
    if (!contract) throw new NotFoundException(`contract ${contractId} not found`);
    return this.seasonRepo.findById(seasonId, contractId);
  }

  // ---- child age bands -----------------------------------------------------

  async createChildAgeBand(
    input: CreateChildAgeBandInput,
    actorId: string,
  ): Promise<ChildAgeBandAdminRow> {
    const contract = await this.contractRepo.findById(
      input.contractId,
      input.tenantId,
    );
    if (!contract) {
      throw new NotFoundException(`contract ${input.contractId} not found`);
    }
    if (contract.status === 'INACTIVE') {
      throw new BadRequestException(
        'cannot add child age bands to an INACTIVE contract',
      );
    }

    const row = await this.bandRepo.insert({
      id: newUlid(),
      contractId: input.contractId,
      name: input.name,
      ageMin: input.ageMin,
      ageMax: input.ageMax,
    });
    await this.audit.write({
      tenantId: input.tenantId,
      actorId,
      resourceType: 'direct_contract_child_age_band',
      resourceId: row.id,
      operation: 'CREATE',
      payload: input as unknown as Record<string, unknown>,
    });
    return row;
  }

  async patchChildAgeBand(
    contractId: string,
    tenantId: string,
    bandId: string,
    patch: PatchChildAgeBandInput,
    actorId: string,
  ): Promise<ChildAgeBandAdminRow> {
    const contract = await this.contractRepo.findById(contractId, tenantId);
    if (!contract) throw new NotFoundException(`contract ${contractId} not found`);
    if (contract.status === 'INACTIVE') {
      throw new BadRequestException(
        'cannot modify child age bands on an INACTIVE contract',
      );
    }
    const row = await this.bandRepo.patch(bandId, contractId, patch);
    await this.audit.write({
      tenantId,
      actorId,
      resourceType: 'direct_contract_child_age_band',
      resourceId: bandId,
      operation: 'PATCH',
      payload: patch as unknown as Record<string, unknown>,
    });
    return row;
  }

  async deleteChildAgeBand(
    contractId: string,
    tenantId: string,
    bandId: string,
    actorId: string,
  ): Promise<void> {
    const contract = await this.contractRepo.findById(contractId, tenantId);
    if (!contract) throw new NotFoundException(`contract ${contractId} not found`);
    await this.bandRepo.delete(bandId, contractId);
    await this.audit.write({
      tenantId,
      actorId,
      resourceType: 'direct_contract_child_age_band',
      resourceId: bandId,
      operation: 'DELETE',
      payload: { contractId },
    });
  }

  async listChildAgeBands(
    contractId: string,
    tenantId: string,
  ): Promise<ReadonlyArray<ChildAgeBandAdminRow>> {
    const contract = await this.contractRepo.findById(contractId, tenantId);
    if (!contract) throw new NotFoundException(`contract ${contractId} not found`);
    return this.bandRepo.list(contractId);
  }

  async findChildAgeBandById(
    contractId: string,
    tenantId: string,
    bandId: string,
  ): Promise<ChildAgeBandAdminRow | null> {
    const contract = await this.contractRepo.findById(contractId, tenantId);
    if (!contract) throw new NotFoundException(`contract ${contractId} not found`);
    return this.bandRepo.findById(bandId, contractId);
  }

  // ---- base rates ----------------------------------------------------------

  async createBaseRate(
    input: CreateBaseRateInput,
    actorId: string,
  ): Promise<BaseRateAdminRow> {
    const contract = await this.contractRepo.findById(
      input.contractId,
      input.tenantId,
    );
    if (!contract) {
      throw new NotFoundException(`contract ${input.contractId} not found`);
    }
    if (contract.status === 'INACTIVE') {
      throw new BadRequestException(
        'cannot add base rates to an INACTIVE contract',
      );
    }
    const row = await this.baseRateRepo.insert({
      id: newUlid(),
      contractId: input.contractId,
      seasonId: input.seasonId,
      roomTypeId: input.roomTypeId,
      ratePlanId: input.ratePlanId,
      occupancyTemplateId: input.occupancyTemplateId,
      includedMealPlanId: input.includedMealPlanId,
      amountMinorUnits: input.amountMinorUnits,
      currency: input.currency,
    });
    await this.audit.write({
      tenantId: input.tenantId,
      actorId,
      resourceType: 'direct_contract_base_rate',
      resourceId: row.id,
      operation: 'CREATE',
      payload: input as unknown as Record<string, unknown>,
    });
    return row;
  }

  async patchBaseRate(
    contractId: string,
    tenantId: string,
    baseRateId: string,
    patch: PatchBaseRateInput,
    actorId: string,
  ): Promise<BaseRateAdminRow> {
    const contract = await this.contractRepo.findById(contractId, tenantId);
    if (!contract) throw new NotFoundException(`contract ${contractId} not found`);
    if (contract.status === 'INACTIVE') {
      throw new BadRequestException(
        'cannot modify base rates on an INACTIVE contract',
      );
    }
    const row = await this.baseRateRepo.patch(baseRateId, contractId, patch);
    await this.audit.write({
      tenantId,
      actorId,
      resourceType: 'direct_contract_base_rate',
      resourceId: baseRateId,
      operation: 'PATCH',
      payload: patch as unknown as Record<string, unknown>,
    });
    return row;
  }

  async deleteBaseRate(
    contractId: string,
    tenantId: string,
    baseRateId: string,
    actorId: string,
  ): Promise<void> {
    const contract = await this.contractRepo.findById(contractId, tenantId);
    if (!contract) throw new NotFoundException(`contract ${contractId} not found`);
    await this.baseRateRepo.delete(baseRateId, contractId);
    await this.audit.write({
      tenantId,
      actorId,
      resourceType: 'direct_contract_base_rate',
      resourceId: baseRateId,
      operation: 'DELETE',
      payload: { contractId },
    });
  }

  async listBaseRates(
    contractId: string,
    tenantId: string,
    seasonId?: string,
  ): Promise<ReadonlyArray<BaseRateAdminRow>> {
    const contract = await this.contractRepo.findById(contractId, tenantId);
    if (!contract) throw new NotFoundException(`contract ${contractId} not found`);
    return this.baseRateRepo.list(contractId, seasonId);
  }

  async findBaseRateById(
    contractId: string,
    tenantId: string,
    baseRateId: string,
  ): Promise<BaseRateAdminRow | null> {
    const contract = await this.contractRepo.findById(contractId, tenantId);
    if (!contract) throw new NotFoundException(`contract ${contractId} not found`);
    return this.baseRateRepo.findById(baseRateId, contractId);
  }

  // ---- occupancy supplements -----------------------------------------------

  async createOccupancySupplement(
    input: CreateOccupancySupplementInput,
    actorId: string,
  ): Promise<OccupancySupplementAdminRow> {
    const contract = await this.contractRepo.findById(
      input.contractId,
      input.tenantId,
    );
    if (!contract) {
      throw new NotFoundException(`contract ${input.contractId} not found`);
    }
    if (contract.status === 'INACTIVE') {
      throw new BadRequestException(
        'cannot add occupancy supplements to an INACTIVE contract',
      );
    }
    if (input.occupantKind === 'EXTRA_CHILD' && !input.childAgeBandId) {
      throw new BadRequestException(
        'childAgeBandId is required for EXTRA_CHILD supplements',
      );
    }
    if (input.occupantKind === 'EXTRA_ADULT' && input.childAgeBandId) {
      throw new BadRequestException(
        'childAgeBandId must not be set for EXTRA_ADULT supplements',
      );
    }
    const row = await this.occSuppRepo.insert({
      id: newUlid(),
      contractId: input.contractId,
      seasonId: input.seasonId,
      roomTypeId: input.roomTypeId,
      ratePlanId: input.ratePlanId,
      occupantKind: input.occupantKind,
      childAgeBandId: input.childAgeBandId,
      slotIndex: input.slotIndex,
      amountMinorUnits: input.amountMinorUnits,
      pricingBasis: 'PER_NIGHT_PER_PERSON',
    });
    await this.audit.write({
      tenantId: input.tenantId,
      actorId,
      resourceType: 'direct_contract_occupancy_supplement',
      resourceId: row.id,
      operation: 'CREATE',
      payload: input as unknown as Record<string, unknown>,
    });
    return row;
  }

  async patchOccupancySupplement(
    contractId: string,
    tenantId: string,
    supplementId: string,
    patch: PatchOccupancySupplementInput,
    actorId: string,
  ): Promise<OccupancySupplementAdminRow> {
    const contract = await this.contractRepo.findById(contractId, tenantId);
    if (!contract) throw new NotFoundException(`contract ${contractId} not found`);
    if (contract.status === 'INACTIVE') {
      throw new BadRequestException(
        'cannot modify occupancy supplements on an INACTIVE contract',
      );
    }
    const row = await this.occSuppRepo.patch(supplementId, contractId, patch);
    await this.audit.write({
      tenantId,
      actorId,
      resourceType: 'direct_contract_occupancy_supplement',
      resourceId: supplementId,
      operation: 'PATCH',
      payload: patch as unknown as Record<string, unknown>,
    });
    return row;
  }

  async deleteOccupancySupplement(
    contractId: string,
    tenantId: string,
    supplementId: string,
    actorId: string,
  ): Promise<void> {
    const contract = await this.contractRepo.findById(contractId, tenantId);
    if (!contract) throw new NotFoundException(`contract ${contractId} not found`);
    await this.occSuppRepo.delete(supplementId, contractId);
    await this.audit.write({
      tenantId,
      actorId,
      resourceType: 'direct_contract_occupancy_supplement',
      resourceId: supplementId,
      operation: 'DELETE',
      payload: { contractId },
    });
  }

  async listOccupancySupplements(
    contractId: string,
    tenantId: string,
    seasonId?: string,
  ): Promise<ReadonlyArray<OccupancySupplementAdminRow>> {
    const contract = await this.contractRepo.findById(contractId, tenantId);
    if (!contract) throw new NotFoundException(`contract ${contractId} not found`);
    return this.occSuppRepo.list(contractId, seasonId);
  }

  async findOccupancySupplementById(
    contractId: string,
    tenantId: string,
    supplementId: string,
  ): Promise<OccupancySupplementAdminRow | null> {
    const contract = await this.contractRepo.findById(contractId, tenantId);
    if (!contract) throw new NotFoundException(`contract ${contractId} not found`);
    return this.occSuppRepo.findById(supplementId, contractId);
  }

  // ---- meal supplements ----------------------------------------------------

  async createMealSupplement(
    input: CreateMealSupplementInput,
    actorId: string,
  ): Promise<MealSupplementAdminRow> {
    const contract = await this.contractRepo.findById(
      input.contractId,
      input.tenantId,
    );
    if (!contract) {
      throw new NotFoundException(`contract ${input.contractId} not found`);
    }
    if (contract.status === 'INACTIVE') {
      throw new BadRequestException(
        'cannot add meal supplements to an INACTIVE contract',
      );
    }
    if (input.occupantKind === 'CHILD' && !input.childAgeBandId) {
      throw new BadRequestException(
        'childAgeBandId is required for CHILD meal supplements',
      );
    }
    if (input.occupantKind === 'ADULT' && input.childAgeBandId) {
      throw new BadRequestException(
        'childAgeBandId must not be set for ADULT meal supplements',
      );
    }
    const row = await this.mealSuppRepo.insert({
      id: newUlid(),
      contractId: input.contractId,
      seasonId: input.seasonId,
      roomTypeId: input.roomTypeId,
      ratePlanId: input.ratePlanId,
      targetMealPlanId: input.targetMealPlanId,
      occupantKind: input.occupantKind,
      childAgeBandId: input.childAgeBandId,
      amountMinorUnits: input.amountMinorUnits,
      pricingBasis: 'PER_NIGHT_PER_PERSON',
    });
    await this.audit.write({
      tenantId: input.tenantId,
      actorId,
      resourceType: 'direct_contract_meal_supplement',
      resourceId: row.id,
      operation: 'CREATE',
      payload: input as unknown as Record<string, unknown>,
    });
    return row;
  }

  async patchMealSupplement(
    contractId: string,
    tenantId: string,
    supplementId: string,
    patch: PatchMealSupplementInput,
    actorId: string,
  ): Promise<MealSupplementAdminRow> {
    const contract = await this.contractRepo.findById(contractId, tenantId);
    if (!contract) throw new NotFoundException(`contract ${contractId} not found`);
    if (contract.status === 'INACTIVE') {
      throw new BadRequestException(
        'cannot modify meal supplements on an INACTIVE contract',
      );
    }
    const row = await this.mealSuppRepo.patch(supplementId, contractId, patch);
    await this.audit.write({
      tenantId,
      actorId,
      resourceType: 'direct_contract_meal_supplement',
      resourceId: supplementId,
      operation: 'PATCH',
      payload: patch as unknown as Record<string, unknown>,
    });
    return row;
  }

  async deleteMealSupplement(
    contractId: string,
    tenantId: string,
    supplementId: string,
    actorId: string,
  ): Promise<void> {
    const contract = await this.contractRepo.findById(contractId, tenantId);
    if (!contract) throw new NotFoundException(`contract ${contractId} not found`);
    await this.mealSuppRepo.delete(supplementId, contractId);
    await this.audit.write({
      tenantId,
      actorId,
      resourceType: 'direct_contract_meal_supplement',
      resourceId: supplementId,
      operation: 'DELETE',
      payload: { contractId },
    });
  }

  async listMealSupplements(
    contractId: string,
    tenantId: string,
    seasonId?: string,
  ): Promise<ReadonlyArray<MealSupplementAdminRow>> {
    const contract = await this.contractRepo.findById(contractId, tenantId);
    if (!contract) throw new NotFoundException(`contract ${contractId} not found`);
    return this.mealSuppRepo.list(contractId, seasonId);
  }

  async findMealSupplementById(
    contractId: string,
    tenantId: string,
    supplementId: string,
  ): Promise<MealSupplementAdminRow | null> {
    const contract = await this.contractRepo.findById(contractId, tenantId);
    if (!contract) throw new NotFoundException(`contract ${contractId} not found`);
    return this.mealSuppRepo.findById(supplementId, contractId);
  }

  // ---- restrictions (ADR-023) ----------------------------------------------
  //
  // Two surfaces, kept deliberately separate:
  //
  //   • Contract-scoped: writes / reads keyed on a contract URL param.
  //     INACTIVE contracts block writes (mirrors Phase A D7). Composite
  //     FK on (season_id, contract_id) → rate_auth_season(id, contract_id)
  //     enforces same-contract membership at the DB layer when seasonId
  //     is non-null. RELEASE_HOURS / CUTOFF_HOURS are rejected here in
  //     Phase B per the user's explicit constraint.
  //
  //   • Supplier-default: writes / reads with `contract_id IS NULL`.
  //     The supplier must exist with `source_type = 'DIRECT'` so this
  //     stays inside the direct-contracts module's mental model.
  //     Channel-manager kinds (RELEASE_HOURS / CUTOFF_HOURS) are
  //     allowed here so the model remains uniform when an adapter
  //     ships in a future phase.
  //
  // Mutation surface is create + supersede only — no patch, no delete
  // (ADR-023 D8). Audit semantics use CREATE for the new row and PATCH
  // on the old row when superseding, never a new SUPERSEDE operation
  // value, per the user's instruction.

  async createContractRestriction(
    input: CreateContractRestrictionInput,
    actorId: string,
  ): Promise<RestrictionAdminRow> {
    if (RESTRICTION_KINDS_FORBIDDEN_FOR_CONTRACT_SCOPED.has(input.restrictionKind)) {
      throw new BadRequestException(
        `restriction kind ${input.restrictionKind} is not allowed on a contract-scoped restriction in Phase B`,
      );
    }
    validateRestrictionParams(input.restrictionKind, input.params);

    const contract = await this.contractRepo.findById(
      input.contractId,
      input.tenantId,
    );
    if (!contract) {
      throw new NotFoundException(`contract ${input.contractId} not found`);
    }
    if (contract.status === 'INACTIVE') {
      throw new BadRequestException(
        'cannot add restrictions to an INACTIVE contract',
      );
    }
    if (input.supplierId !== contract.supplierId) {
      throw new BadRequestException(
        'restriction supplierId must match the contract supplierId',
      );
    }
    if (input.canonicalHotelId !== contract.canonicalHotelId) {
      throw new BadRequestException(
        'restriction canonicalHotelId must match the contract canonicalHotelId',
      );
    }

    const row = await this.restrictionRepo.insert({
      id: newUlid(),
      tenantId: input.tenantId,
      supplierId: input.supplierId,
      canonicalHotelId: input.canonicalHotelId,
      ratePlanId: input.ratePlanId,
      roomTypeId: input.roomTypeId,
      contractId: input.contractId,
      seasonId: input.seasonId,
      stayDate: input.stayDate,
      restrictionKind: input.restrictionKind,
      params: input.params,
      effectiveFrom: input.effectiveFrom,
      effectiveTo: input.effectiveTo,
    });

    await this.audit.write({
      tenantId: input.tenantId,
      actorId,
      resourceType: 'direct_contract_restriction',
      resourceId: row.id,
      operation: 'CREATE',
      payload: input as unknown as Record<string, unknown>,
    });
    return row;
  }

  async createSupplierRestriction(
    input: CreateSupplierRestrictionInput,
    actorId: string,
  ): Promise<RestrictionAdminRow> {
    validateRestrictionParams(input.restrictionKind, input.params);
    await this.requireDirectSupplier(input.supplierId);

    const row = await this.restrictionRepo.insert({
      id: newUlid(),
      tenantId: input.tenantId,
      supplierId: input.supplierId,
      canonicalHotelId: input.canonicalHotelId,
      ratePlanId: input.ratePlanId,
      roomTypeId: input.roomTypeId,
      contractId: null,
      seasonId: null,
      stayDate: input.stayDate,
      restrictionKind: input.restrictionKind,
      params: input.params,
      effectiveFrom: input.effectiveFrom,
      effectiveTo: input.effectiveTo,
    });

    await this.audit.write({
      tenantId: input.tenantId,
      actorId,
      resourceType: 'supplier_default_restriction',
      resourceId: row.id,
      operation: 'CREATE',
      payload: input as unknown as Record<string, unknown>,
    });
    return row;
  }

  async supersedeContractRestriction(
    contractId: string,
    tenantId: string,
    oldId: string,
    newInput: CreateContractRestrictionInput,
    actorId: string,
  ): Promise<RestrictionAdminRow> {
    if (RESTRICTION_KINDS_FORBIDDEN_FOR_CONTRACT_SCOPED.has(newInput.restrictionKind)) {
      throw new BadRequestException(
        `restriction kind ${newInput.restrictionKind} is not allowed on a contract-scoped restriction in Phase B`,
      );
    }
    validateRestrictionParams(newInput.restrictionKind, newInput.params);

    const contract = await this.contractRepo.findById(contractId, tenantId);
    if (!contract) {
      throw new NotFoundException(`contract ${contractId} not found`);
    }
    if (contract.status === 'INACTIVE') {
      throw new BadRequestException(
        'cannot supersede restrictions on an INACTIVE contract',
      );
    }
    if (newInput.supplierId !== contract.supplierId) {
      throw new BadRequestException(
        'restriction supplierId must match the contract supplierId',
      );
    }
    if (newInput.canonicalHotelId !== contract.canonicalHotelId) {
      throw new BadRequestException(
        'restriction canonicalHotelId must match the contract canonicalHotelId',
      );
    }

    const result = await this.restrictionRepo.supersede({
      oldId,
      requireContractId: contractId,
      newRow: {
        id: newUlid(),
        tenantId: newInput.tenantId,
        supplierId: newInput.supplierId,
        canonicalHotelId: newInput.canonicalHotelId,
        ratePlanId: newInput.ratePlanId,
        roomTypeId: newInput.roomTypeId,
        contractId,
        seasonId: newInput.seasonId,
        stayDate: newInput.stayDate,
        restrictionKind: newInput.restrictionKind,
        params: newInput.params,
        effectiveFrom: newInput.effectiveFrom,
        effectiveTo: newInput.effectiveTo,
      },
    });

    await this.audit.write({
      tenantId,
      actorId,
      resourceType: 'direct_contract_restriction',
      resourceId: result.newRow.id,
      operation: 'CREATE',
      payload: {
        ...(newInput as unknown as Record<string, unknown>),
        supersedesId: oldId,
      },
    });
    await this.audit.write({
      tenantId,
      actorId,
      resourceType: 'direct_contract_restriction',
      resourceId: oldId,
      operation: 'PATCH',
      payload: { supersededById: result.newRow.id },
    });

    return result.newRow;
  }

  async supersedeSupplierRestriction(
    tenantId: string,
    oldId: string,
    newInput: CreateSupplierRestrictionInput,
    actorId: string,
  ): Promise<RestrictionAdminRow> {
    validateRestrictionParams(newInput.restrictionKind, newInput.params);
    await this.requireDirectSupplier(newInput.supplierId);

    // Cross-tenant guard: the old row must belong to the caller's
    // tenant. The repo's `supersede` does not filter by tenant; we
    // do it here so a wrong-tenant supersede returns 404.
    const existing = await this.restrictionRepo.findById(oldId, tenantId);
    if (!existing) {
      throw new NotFoundException(`restriction ${oldId} not found`);
    }
    if (existing.contractId !== null) {
      throw new NotFoundException(
        `restriction ${oldId} is contract-scoped; use the contract-scoped supersede endpoint`,
      );
    }

    const result = await this.restrictionRepo.supersede({
      oldId,
      requireContractId: null,
      newRow: {
        id: newUlid(),
        tenantId: newInput.tenantId,
        supplierId: newInput.supplierId,
        canonicalHotelId: newInput.canonicalHotelId,
        ratePlanId: newInput.ratePlanId,
        roomTypeId: newInput.roomTypeId,
        contractId: null,
        seasonId: null,
        stayDate: newInput.stayDate,
        restrictionKind: newInput.restrictionKind,
        params: newInput.params,
        effectiveFrom: newInput.effectiveFrom,
        effectiveTo: newInput.effectiveTo,
      },
    });

    await this.audit.write({
      tenantId,
      actorId,
      resourceType: 'supplier_default_restriction',
      resourceId: result.newRow.id,
      operation: 'CREATE',
      payload: {
        ...(newInput as unknown as Record<string, unknown>),
        supersedesId: oldId,
      },
    });
    await this.audit.write({
      tenantId,
      actorId,
      resourceType: 'supplier_default_restriction',
      resourceId: oldId,
      operation: 'PATCH',
      payload: { supersededById: result.newRow.id },
    });

    return result.newRow;
  }

  async findContractRestrictionById(
    contractId: string,
    tenantId: string,
    id: string,
  ): Promise<RestrictionAdminRow | null> {
    const contract = await this.contractRepo.findById(contractId, tenantId);
    if (!contract) throw new NotFoundException(`contract ${contractId} not found`);
    return this.restrictionRepo.findContractScopedById(id, contractId);
  }

  async findSupplierRestrictionById(
    tenantId: string,
    id: string,
  ): Promise<RestrictionAdminRow | null> {
    const row = await this.restrictionRepo.findById(id, tenantId);
    if (!row) return null;
    if (row.contractId !== null) {
      // Surface as not-found to keep the supplier-default surface from
      // leaking contract-scoped rows.
      return null;
    }
    return row;
  }

  async listContractRestrictions(
    contractId: string,
    tenantId: string,
    opts: { seasonId?: string; includeSuperseded?: boolean } = {},
  ): Promise<ReadonlyArray<RestrictionAdminRow>> {
    const contract = await this.contractRepo.findById(contractId, tenantId);
    if (!contract) throw new NotFoundException(`contract ${contractId} not found`);
    return this.restrictionRepo.listForContract(contractId, opts);
  }

  async listSupplierRestrictions(args: {
    tenantId: string;
    supplierId: string;
    canonicalHotelId: string;
    includeSuperseded?: boolean;
  }): Promise<ReadonlyArray<RestrictionAdminRow>> {
    return this.restrictionRepo.listSupplierDefault(args);
  }

  // ---- private helpers -----------------------------------------------------

  private async requireDirectSupplier(supplierId: string): Promise<void> {
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT id FROM supply_supplier WHERE id = $1 AND source_type = 'DIRECT'`,
      [supplierId],
    );
    if (rows.length === 0) {
      throw new BadRequestException(
        `supplier ${supplierId} does not exist or is not source_type = 'DIRECT'`,
      );
    }
  }
}

function requireDateOrder(
  from: string | undefined | null,
  to: string | undefined | null,
): void {
  if (from && to && Date.parse(to) < Date.parse(from)) {
    throw new BadRequestException(
      'validTo / dateTo must be on or after validFrom / dateFrom',
    );
  }
}
