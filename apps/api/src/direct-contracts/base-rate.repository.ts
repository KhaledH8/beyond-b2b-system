import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Pool } from '@bb/db';
import { PG_POOL } from '../database/database.module';

export interface BaseRateAdminRow {
  readonly id: string;
  readonly contractId: string;
  readonly seasonId: string;
  readonly roomTypeId: string;
  readonly ratePlanId: string;
  readonly occupancyTemplateId: string;
  readonly includedMealPlanId: string;
  readonly amountMinorUnits: number;
  readonly currency: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface DbRow {
  readonly id: string;
  readonly contract_id: string;
  readonly season_id: string;
  readonly room_type_id: string;
  readonly rate_plan_id: string;
  readonly occupancy_template_id: string;
  readonly included_meal_plan_id: string;
  readonly amount_minor_units: string; // pg returns BIGINT as string
  readonly currency: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

@Injectable()
export class BaseRateRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async insert(row: {
    id: string;
    contractId: string;
    seasonId: string;
    roomTypeId: string;
    ratePlanId: string;
    occupancyTemplateId: string;
    includedMealPlanId: string;
    amountMinorUnits: number;
    currency: string;
  }): Promise<BaseRateAdminRow> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `INSERT INTO rate_auth_base_rate
           (id, contract_id, season_id, room_type_id, rate_plan_id,
            occupancy_template_id, included_meal_plan_id, amount_minor_units, currency)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          row.id,
          row.contractId,
          row.seasonId,
          row.roomTypeId,
          row.ratePlanId,
          row.occupancyTemplateId,
          row.includedMealPlanId,
          row.amountMinorUnits,
          row.currency,
        ],
      );
      return toRow(rows[0]!);
    } catch (err) {
      throw translatePgError(err);
    }
  }

  async findById(
    id: string,
    contractId: string,
  ): Promise<BaseRateAdminRow | null> {
    const { rows } = await this.pool.query<DbRow>(
      `SELECT * FROM rate_auth_base_rate WHERE id = $1 AND contract_id = $2`,
      [id, contractId],
    );
    return rows[0] ? toRow(rows[0]) : null;
  }

  async list(
    contractId: string,
    seasonId?: string,
  ): Promise<ReadonlyArray<BaseRateAdminRow>> {
    const { rows } = await this.pool.query<DbRow>(
      `SELECT * FROM rate_auth_base_rate
        WHERE contract_id = $1
          AND ($2::char(26) IS NULL OR season_id = $2)
        ORDER BY created_at DESC`,
      [contractId, seasonId ?? null],
    );
    return rows.map(toRow);
  }

  async patch(
    id: string,
    contractId: string,
    patch: { amountMinorUnits?: number; includedMealPlanId?: string },
  ): Promise<BaseRateAdminRow> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `UPDATE rate_auth_base_rate
            SET amount_minor_units    = COALESCE($3::bigint,   amount_minor_units),
                included_meal_plan_id = COALESCE($4::char(26), included_meal_plan_id),
                updated_at            = now()
          WHERE id = $1 AND contract_id = $2
          RETURNING *`,
        [
          id,
          contractId,
          patch.amountMinorUnits ?? null,
          patch.includedMealPlanId ?? null,
        ],
      );
      if (rows.length === 0) {
        throw new NotFoundException(`base rate ${id} not found`);
      }
      return toRow(rows[0]!);
    } catch (err) {
      throw translatePgError(err);
    }
  }

  async delete(id: string, contractId: string): Promise<void> {
    const result = await this.pool.query(
      `DELETE FROM rate_auth_base_rate WHERE id = $1 AND contract_id = $2`,
      [id, contractId],
    );
    if ((result.rowCount ?? 0) === 0) {
      throw new NotFoundException(`base rate ${id} not found`);
    }
  }
}

function toRow(r: DbRow): BaseRateAdminRow {
  return {
    id: r.id,
    contractId: r.contract_id,
    seasonId: r.season_id,
    roomTypeId: r.room_type_id,
    ratePlanId: r.rate_plan_id,
    occupancyTemplateId: r.occupancy_template_id,
    includedMealPlanId: r.included_meal_plan_id,
    amountMinorUnits: Number(r.amount_minor_units),
    currency: r.currency,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

function translatePgError(err: unknown): Error {
  if (typeof err !== 'object' || err === null) return err as Error;
  const e = err as { code?: string; constraint?: string };
  if (e.code === '23503') {
    return new ConflictException(
      `Referenced row does not exist: ${e.constraint ?? 'foreign key'}`,
    );
  }
  if (e.code === '23505') {
    return new ConflictException(
      `Duplicate value: ${e.constraint ?? 'unique constraint'}`,
    );
  }
  if (e.code === '23514') {
    return new ConflictException(
      `Constraint violated: ${e.constraint ?? 'check'}`,
    );
  }
  return err as Error;
}
