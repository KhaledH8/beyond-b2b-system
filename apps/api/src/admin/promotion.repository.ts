import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Pool } from '@bb/db';
import type { AccountType, PromotionKind } from '@bb/domain';
import { PG_POOL } from '../database/database.module';

export interface PromotionAdminRow {
  readonly id: string;
  readonly tenantId: string;
  readonly supplierHotelId: string;
  readonly kind: PromotionKind;
  readonly priority: number;
  readonly accountType: AccountType | null;
  readonly validFrom: string | null;
  readonly validTo: string | null;
  readonly status: 'ACTIVE' | 'INACTIVE';
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface DbRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly supplier_hotel_id: string;
  readonly kind: PromotionKind;
  readonly priority: number;
  readonly account_type: AccountType | null;
  readonly valid_from: Date | null;
  readonly valid_to: Date | null;
  readonly status: 'ACTIVE' | 'INACTIVE';
  readonly created_at: Date;
  readonly updated_at: Date;
}

/**
 * CRUD repository over `merch_promotion`.
 *
 * Promotions are decorative tags only — search-side
 * `PgPromotionRepository` reads them but pricing never sees them.
 * Admin therefore needs no special invariants beyond schema-level
 * checks (FK + enum + time window). Soft-delete via `INACTIVE` so
 * stale references in older traces still dereference.
 */
@Injectable()
export class PromotionAdminRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async insert(row: {
    id: string;
    tenantId: string;
    supplierHotelId: string;
    kind: PromotionKind;
    priority: number;
    accountType?: AccountType;
    validFrom?: string;
    validTo?: string;
  }): Promise<PromotionAdminRow> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `
        INSERT INTO merch_promotion (
          id, tenant_id, supplier_hotel_id, kind, priority,
          account_type, valid_from, valid_to, status
        )
        VALUES (
          $1, $2, $3, $4, $5,
          $6, $7::timestamptz, $8::timestamptz, 'ACTIVE'
        )
        RETURNING *
        `,
        [
          row.id,
          row.tenantId,
          row.supplierHotelId,
          row.kind,
          row.priority,
          row.accountType ?? null,
          row.validFrom ?? null,
          row.validTo ?? null,
        ],
      );
      return toAdminRow(rows[0]!);
    } catch (err) {
      throw translatePgError(err);
    }
  }

  async findById(
    id: string,
    tenantId: string,
  ): Promise<PromotionAdminRow | null> {
    const { rows } = await this.pool.query<DbRow>(
      `SELECT * FROM merch_promotion WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    return rows[0] ? toAdminRow(rows[0]) : null;
  }

  async list(filter: {
    tenantId: string;
    supplierHotelId?: string;
    accountType?: AccountType;
    kind?: PromotionKind;
    status?: 'ACTIVE' | 'INACTIVE';
    limit?: number;
    offset?: number;
  }): Promise<ReadonlyArray<PromotionAdminRow>> {
    const limit = filter.limit ?? 100;
    const offset = filter.offset ?? 0;
    const { rows } = await this.pool.query<DbRow>(
      `
      SELECT * FROM merch_promotion
       WHERE tenant_id = $1
         AND ($2::char(26) IS NULL OR supplier_hotel_id = $2)
         AND ($3::text IS NULL OR account_type = $3)
         AND ($4::text IS NULL OR kind = $4)
         AND ($5::text IS NULL OR status = $5)
       ORDER BY created_at DESC
       LIMIT $6 OFFSET $7
      `,
      [
        filter.tenantId,
        filter.supplierHotelId ?? null,
        filter.accountType ?? null,
        filter.kind ?? null,
        filter.status ?? null,
        limit,
        offset,
      ],
    );
    return rows.map(toAdminRow);
  }

  /**
   * Patchable: kind, priority, accountType, validFrom, validTo, status.
   * `tenantId` and `supplierHotelId` are create-time-only — changing
   * them effectively makes a different promotion (re-create instead).
   *
   * `accountType` supports a tri-state: present-with-value sets the
   * channel filter; present-with-null clears it (the promotion now
   * applies to all channels); absent leaves unchanged.
   */
  async patch(
    id: string,
    tenantId: string,
    patch: {
      kind?: PromotionKind;
      priority?: number;
      accountType?: AccountType | null;
      validFrom?: string | null;
      validTo?: string | null;
      status?: 'ACTIVE' | 'INACTIVE';
    },
  ): Promise<PromotionAdminRow> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `
        UPDATE merch_promotion
           SET kind         = COALESCE($3::text,        kind),
               priority     = COALESCE($4::integer,     priority),
               account_type = CASE WHEN $5::boolean THEN $6::text
                                   ELSE account_type END,
               valid_from   = CASE WHEN $7::boolean THEN $8::timestamptz
                                   ELSE valid_from END,
               valid_to     = CASE WHEN $9::boolean THEN $10::timestamptz
                                   ELSE valid_to END,
               status       = COALESCE($11::text,       status),
               updated_at   = now()
         WHERE id = $1 AND tenant_id = $2
         RETURNING *
        `,
        [
          id,
          tenantId,
          patch.kind ?? null,
          patch.priority ?? null,
          patch.accountType !== undefined,
          patch.accountType ?? null,
          patch.validFrom !== undefined,
          patch.validFrom ?? null,
          patch.validTo !== undefined,
          patch.validTo ?? null,
          patch.status ?? null,
        ],
      );
      if (rows.length === 0) {
        throw new NotFoundException(`merch_promotion ${id} not found`);
      }
      return toAdminRow(rows[0]!);
    } catch (err) {
      throw translatePgError(err);
    }
  }

  async softDelete(id: string, tenantId: string): Promise<PromotionAdminRow> {
    return this.patch(id, tenantId, { status: 'INACTIVE' });
  }
}

function toAdminRow(r: DbRow): PromotionAdminRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    supplierHotelId: r.supplier_hotel_id,
    kind: r.kind,
    priority: r.priority,
    accountType: r.account_type,
    validFrom: r.valid_from ? r.valid_from.toISOString() : null,
    validTo: r.valid_to ? r.valid_to.toISOString() : null,
    status: r.status,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

function translatePgError(err: unknown): Error {
  if (typeof err !== 'object' || err === null) return err as Error;
  const e = err as { code?: string; message?: string; constraint?: string };
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
