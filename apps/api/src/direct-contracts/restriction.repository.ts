import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Pool } from '@bb/db';
import { PG_POOL } from '../database/database.module';

export interface RestrictionAdminRow {
  readonly id: string;
  readonly tenantId: string;
  readonly supplierId: string;
  readonly canonicalHotelId: string;
  readonly ratePlanId: string | null;
  readonly roomTypeId: string | null;
  readonly contractId: string | null;
  readonly seasonId: string | null;
  readonly stayDate: string;
  readonly restrictionKind: string;
  readonly params: Record<string, unknown>;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly supersededById: string | null;
  readonly createdAt: string;
}

interface DbRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly supplier_id: string;
  readonly canonical_hotel_id: string;
  readonly rate_plan_id: string | null;
  readonly room_type_id: string | null;
  readonly contract_id: string | null;
  readonly season_id: string | null;
  readonly stay_date: string;
  readonly restriction_kind: string;
  readonly params: Record<string, unknown>;
  readonly effective_from: Date;
  readonly effective_to: Date | null;
  readonly superseded_by_id: string | null;
  readonly created_at: Date;
}

export interface InsertRestrictionInput {
  readonly id: string;
  readonly tenantId: string;
  readonly supplierId: string;
  readonly canonicalHotelId: string;
  readonly ratePlanId: string | null;
  readonly roomTypeId: string | null;
  readonly contractId: string | null;
  readonly seasonId: string | null;
  readonly stayDate: string;
  readonly restrictionKind: string;
  readonly params: Record<string, unknown>;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
}

export interface SupersedeResult {
  readonly oldRow: RestrictionAdminRow;
  readonly newRow: RestrictionAdminRow;
}

/**
 * Repository for `rate_auth_restriction`. Restrictions are
 * append-only: rows are never updated except for the
 * `superseded_by_id` link in `supersede()`. There is no
 * `delete()` method (ADR-023 D8).
 */
@Injectable()
export class RestrictionRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async insert(input: InsertRestrictionInput): Promise<RestrictionAdminRow> {
    try {
      const { rows } = await this.pool.query<DbRow>(INSERT_SQL, params(input));
      return toRow(rows[0]!);
    } catch (err) {
      throw translatePgError(err);
    }
  }

  /**
   * Atomically:
   *   1. Lock the old row (FOR UPDATE) and verify it exists, is not
   *      already superseded, and (when `requireContractId` is set)
   *      lives inside the expected contract scope.
   *   2. Insert the new row.
   *   3. Set `old.superseded_by_id = new.id`.
   *
   * Returns both rows so the caller can write paired audit entries.
   */
  async supersede(args: {
    oldId: string;
    requireContractId?: string | null;
    newRow: InsertRestrictionInput;
  }): Promise<SupersedeResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: oldRows } = await client.query<DbRow>(
        `SELECT * FROM rate_auth_restriction WHERE id = $1 FOR UPDATE`,
        [args.oldId],
      );
      if (oldRows.length === 0) {
        throw new NotFoundException(`restriction ${args.oldId} not found`);
      }
      const oldRowDb = oldRows[0]!;
      if (oldRowDb.superseded_by_id !== null) {
        throw new ConflictException(
          `restriction ${args.oldId} is already superseded by ${oldRowDb.superseded_by_id}`,
        );
      }
      // Scope guard: contract-scoped supersede must target a row in
      // the same contract; supplier-default supersede must target a
      // row with NULL contract_id. Caller passes the expected scope
      // explicitly so the repository never has to guess.
      if (args.requireContractId !== undefined) {
        if (oldRowDb.contract_id !== (args.requireContractId ?? null)) {
          throw new NotFoundException(
            `restriction ${args.oldId} not found in the requested scope`,
          );
        }
      }

      const { rows: newRows } = await client.query<DbRow>(
        INSERT_SQL,
        params(args.newRow),
      );
      const newRowDb = newRows[0]!;

      await client.query(
        `UPDATE rate_auth_restriction
            SET superseded_by_id = $1
          WHERE id = $2`,
        [newRowDb.id, oldRowDb.id],
      );

      await client.query('COMMIT');

      return {
        oldRow: { ...toRow(oldRowDb), supersededById: newRowDb.id },
        newRow: toRow(newRowDb),
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw translatePgError(err);
    } finally {
      client.release();
    }
  }

  async findById(
    id: string,
    tenantId: string,
  ): Promise<RestrictionAdminRow | null> {
    const { rows } = await this.pool.query<DbRow>(
      `SELECT * FROM rate_auth_restriction WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    return rows[0] ? toRow(rows[0]) : null;
  }

  async findContractScopedById(
    id: string,
    contractId: string,
  ): Promise<RestrictionAdminRow | null> {
    const { rows } = await this.pool.query<DbRow>(
      `SELECT * FROM rate_auth_restriction
        WHERE id = $1 AND contract_id = $2`,
      [id, contractId],
    );
    return rows[0] ? toRow(rows[0]) : null;
  }

  async listForContract(
    contractId: string,
    opts: { seasonId?: string; includeSuperseded?: boolean } = {},
  ): Promise<ReadonlyArray<RestrictionAdminRow>> {
    const includeSuperseded = opts.includeSuperseded ?? false;
    const { rows } = await this.pool.query<DbRow>(
      `SELECT * FROM rate_auth_restriction
        WHERE contract_id = $1
          AND ($2::char(26) IS NULL OR season_id = $2)
          AND ($3::boolean OR superseded_by_id IS NULL)
        ORDER BY stay_date ASC, created_at ASC`,
      [contractId, opts.seasonId ?? null, includeSuperseded],
    );
    return rows.map(toRow);
  }

  async listSupplierDefault(
    args: {
      tenantId: string;
      supplierId: string;
      canonicalHotelId: string;
      includeSuperseded?: boolean;
    },
  ): Promise<ReadonlyArray<RestrictionAdminRow>> {
    const includeSuperseded = args.includeSuperseded ?? false;
    const { rows } = await this.pool.query<DbRow>(
      `SELECT * FROM rate_auth_restriction
        WHERE tenant_id = $1
          AND supplier_id = $2
          AND canonical_hotel_id = $3
          AND contract_id IS NULL
          AND ($4::boolean OR superseded_by_id IS NULL)
        ORDER BY stay_date ASC, created_at ASC`,
      [args.tenantId, args.supplierId, args.canonicalHotelId, includeSuperseded],
    );
    return rows.map(toRow);
  }
}

const INSERT_SQL = `
  INSERT INTO rate_auth_restriction (
    id, tenant_id, supplier_id, canonical_hotel_id,
    rate_plan_id, room_type_id, contract_id, season_id,
    stay_date, restriction_kind, params,
    effective_from, effective_to
  )
  VALUES (
    $1, $2, $3, $4,
    $5, $6, $7, $8,
    $9::date, $10, $11::jsonb,
    $12::timestamptz, $13::timestamptz
  )
  RETURNING *
`;

function params(input: InsertRestrictionInput): unknown[] {
  return [
    input.id,
    input.tenantId,
    input.supplierId,
    input.canonicalHotelId,
    input.ratePlanId,
    input.roomTypeId,
    input.contractId,
    input.seasonId,
    input.stayDate,
    input.restrictionKind,
    JSON.stringify(input.params),
    input.effectiveFrom,
    input.effectiveTo,
  ];
}

function toRow(r: DbRow): RestrictionAdminRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    supplierId: r.supplier_id,
    canonicalHotelId: r.canonical_hotel_id,
    ratePlanId: r.rate_plan_id,
    roomTypeId: r.room_type_id,
    contractId: r.contract_id,
    seasonId: r.season_id,
    stayDate: r.stay_date,
    restrictionKind: r.restriction_kind,
    params: r.params,
    effectiveFrom: r.effective_from.toISOString(),
    effectiveTo: r.effective_to ? r.effective_to.toISOString() : null,
    supersededById: r.superseded_by_id,
    createdAt: r.created_at.toISOString(),
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
