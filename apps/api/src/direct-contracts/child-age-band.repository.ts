import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Pool } from '@bb/db';
import { PG_POOL } from '../database/database.module';

export interface ChildAgeBandAdminRow {
  readonly id: string;
  readonly contractId: string;
  readonly name: string;
  readonly ageMin: number;
  readonly ageMax: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface DbRow {
  readonly id: string;
  readonly contract_id: string;
  readonly name: string;
  readonly age_min: number;
  readonly age_max: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

@Injectable()
export class ChildAgeBandRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async insert(row: {
    id: string;
    contractId: string;
    name: string;
    ageMin: number;
    ageMax: number;
  }): Promise<ChildAgeBandAdminRow> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `INSERT INTO rate_auth_child_age_band (id, contract_id, name, age_min, age_max)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [row.id, row.contractId, row.name, row.ageMin, row.ageMax],
      );
      return toRow(rows[0]!);
    } catch (err) {
      throw translatePgError(err);
    }
  }

  async findById(
    id: string,
    contractId: string,
  ): Promise<ChildAgeBandAdminRow | null> {
    const { rows } = await this.pool.query<DbRow>(
      `SELECT * FROM rate_auth_child_age_band WHERE id = $1 AND contract_id = $2`,
      [id, contractId],
    );
    return rows[0] ? toRow(rows[0]) : null;
  }

  async list(contractId: string): Promise<ReadonlyArray<ChildAgeBandAdminRow>> {
    const { rows } = await this.pool.query<DbRow>(
      `SELECT * FROM rate_auth_child_age_band
        WHERE contract_id = $1
        ORDER BY age_min ASC`,
      [contractId],
    );
    return rows.map(toRow);
  }

  async patch(
    id: string,
    contractId: string,
    patch: { name?: string; ageMin?: number; ageMax?: number },
  ): Promise<ChildAgeBandAdminRow> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `UPDATE rate_auth_child_age_band
            SET name       = COALESCE($3::varchar,  name),
                age_min    = COALESCE($4::smallint, age_min),
                age_max    = COALESCE($5::smallint, age_max),
                updated_at = now()
          WHERE id = $1 AND contract_id = $2
          RETURNING *`,
        [
          id,
          contractId,
          patch.name ?? null,
          patch.ageMin ?? null,
          patch.ageMax ?? null,
        ],
      );
      if (rows.length === 0) {
        throw new NotFoundException(`child age band ${id} not found`);
      }
      return toRow(rows[0]!);
    } catch (err) {
      throw translatePgError(err);
    }
  }

  async delete(id: string, contractId: string): Promise<void> {
    try {
      const result = await this.pool.query(
        `DELETE FROM rate_auth_child_age_band WHERE id = $1 AND contract_id = $2`,
        [id, contractId],
      );
      if ((result.rowCount ?? 0) === 0) {
        throw new NotFoundException(`child age band ${id} not found`);
      }
    } catch (err) {
      if (typeof err !== 'object' || err === null) throw err;
      const e = err as { code?: string };
      if (e.code === '23503') {
        throw new ConflictException(
          'child age band is referenced by supplements and cannot be deleted',
        );
      }
      throw err;
    }
  }
}

function toRow(r: DbRow): ChildAgeBandAdminRow {
  return {
    id: r.id,
    contractId: r.contract_id,
    name: r.name,
    ageMin: r.age_min,
    ageMax: r.age_max,
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
  if (e.code === '23514') {
    return new ConflictException(
      `Constraint violated: ${e.constraint ?? 'check'}`,
    );
  }
  return err as Error;
}
