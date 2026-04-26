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
