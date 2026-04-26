import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Pool } from '@bb/db';
import { PG_POOL } from '../database/database.module';

export interface SeasonAdminRow {
  readonly id: string;
  readonly contractId: string;
  readonly name: string;
  readonly dateFrom: string;
  readonly dateTo: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface DbRow {
  readonly id: string;
  readonly contract_id: string;
  readonly name: string;
  readonly date_from: string;
  readonly date_to: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

@Injectable()
export class SeasonRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async findById(
    id: string,
    contractId: string,
  ): Promise<SeasonAdminRow | null> {
    const { rows } = await this.pool.query<DbRow>(
      `SELECT * FROM rate_auth_season WHERE id = $1 AND contract_id = $2`,
      [id, contractId],
    );
    return rows[0] ? toRow(rows[0]) : null;
  }

  async list(contractId: string): Promise<ReadonlyArray<SeasonAdminRow>> {
    const { rows } = await this.pool.query<DbRow>(
      `SELECT * FROM rate_auth_season
        WHERE contract_id = $1
        ORDER BY date_from ASC`,
      [contractId],
    );
    return rows.map(toRow);
  }

  async count(contractId: string): Promise<number> {
    const { rows } = await this.pool.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM rate_auth_season WHERE contract_id = $1`,
      [contractId],
    );
    return Number(rows[0]!.cnt);
  }

  async assertNoOverlap(
    contractId: string,
    dateFrom: string,
    dateTo: string,
    excludeId?: string,
  ): Promise<void> {
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT id FROM rate_auth_season
        WHERE contract_id = $1
          AND ($4::char(26) IS NULL OR id != $4)
          AND date_from <= $3::date
          AND date_to   >= $2::date`,
      [contractId, dateFrom, dateTo, excludeId ?? null],
    );
    if (rows.length > 0) {
      throw new ConflictException(
        'season dates overlap with an existing season in this contract',
      );
    }
  }

  async patch(
    id: string,
    contractId: string,
    patch: { name?: string; dateFrom?: string; dateTo?: string },
  ): Promise<SeasonAdminRow> {
    const { rows } = await this.pool.query<DbRow>(
      `UPDATE rate_auth_season
          SET name       = COALESCE($3,       name),
              date_from  = COALESCE($4::date, date_from),
              date_to    = COALESCE($5::date, date_to),
              updated_at = now()
        WHERE id = $1 AND contract_id = $2
        RETURNING *`,
      [
        id,
        contractId,
        patch.name ?? null,
        patch.dateFrom ?? null,
        patch.dateTo ?? null,
      ],
    );
    if (rows.length === 0) throw new NotFoundException(`season ${id} not found`);
    return toRow(rows[0]!);
  }

  async delete(id: string, contractId: string): Promise<void> {
    try {
      const result = await this.pool.query(
        `DELETE FROM rate_auth_season WHERE id = $1 AND contract_id = $2`,
        [id, contractId],
      );
      if ((result.rowCount ?? 0) === 0) {
        throw new NotFoundException(`season ${id} not found`);
      }
    } catch (err) {
      if (typeof err !== 'object' || err === null) throw err;
      const e = err as { code?: string };
      if (e.code === '23503') {
        throw new ConflictException(
          'season is referenced by base rates or supplements and cannot be deleted',
        );
      }
      throw err;
    }
  }
}

function toRow(r: DbRow): SeasonAdminRow {
  return {
    id: r.id,
    contractId: r.contract_id,
    name: r.name,
    dateFrom: r.date_from,
    dateTo: r.date_to,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}
