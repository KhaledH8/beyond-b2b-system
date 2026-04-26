import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Pool } from '@bb/db';
import type { AccountType, MarkupRuleScope } from '@bb/domain';
import { PG_POOL } from '../database/database.module';

/**
 * Admin-side row shape for `pricing_markup_rule`. Distinct from the
 * search-side `MarkupRuleSnapshot` (which is the operational shape
 * the pure evaluator consumes) — admin needs the full audit fields
 * and the scope keys verbatim, including NULLs.
 */
export interface MarkupRuleAdminRow {
  readonly id: string;
  readonly tenantId: string;
  readonly scope: MarkupRuleScope;
  readonly accountId: string | null;
  readonly supplierHotelId: string | null;
  readonly accountType: AccountType | null;
  readonly markupKind: 'PERCENT';
  readonly percentValue: string | null;
  readonly priority: number;
  readonly validFrom: string | null;
  readonly validTo: string | null;
  readonly status: 'ACTIVE' | 'INACTIVE';
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface DbRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly scope: MarkupRuleScope;
  readonly account_id: string | null;
  readonly supplier_hotel_id: string | null;
  readonly account_type: AccountType | null;
  readonly markup_kind: 'PERCENT';
  readonly percent_value: string | null;
  readonly priority: number;
  readonly valid_from: Date | null;
  readonly valid_to: Date | null;
  readonly status: 'ACTIVE' | 'INACTIVE';
  readonly created_at: Date;
  readonly updated_at: Date;
}

/**
 * CRUD repository for admin-side `pricing_markup_rule` operations.
 * Distinct from the search-time `PgMarkupRuleRepository` so the read
 * path (filtered by scope + tenant + time bounds) and the write path
 * (create / patch / soft-delete by id) evolve independently.
 *
 * Foreign-key violations from Postgres are caught and re-thrown as
 * Nest exceptions with helpful messages — a bad accountId becomes a
 * 400 rather than a 500.
 */
@Injectable()
export class MarkupRuleAdminRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async insert(row: {
    id: string;
    tenantId: string;
    scope: MarkupRuleScope;
    accountId?: string;
    supplierHotelId?: string;
    accountType?: AccountType;
    percentValue: string;
    priority: number;
    validFrom?: string;
    validTo?: string;
  }): Promise<MarkupRuleAdminRow> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `
        INSERT INTO pricing_markup_rule (
          id, tenant_id, scope,
          account_id, supplier_hotel_id, account_type,
          markup_kind, percent_value, priority,
          valid_from, valid_to, status
        )
        VALUES (
          $1, $2, $3,
          $4, $5, $6,
          'PERCENT', $7, $8,
          $9::timestamptz, $10::timestamptz, 'ACTIVE'
        )
        RETURNING *
        `,
        [
          row.id,
          row.tenantId,
          row.scope,
          row.accountId ?? null,
          row.supplierHotelId ?? null,
          row.accountType ?? null,
          row.percentValue,
          row.priority,
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
  ): Promise<MarkupRuleAdminRow | null> {
    const { rows } = await this.pool.query<DbRow>(
      `SELECT * FROM pricing_markup_rule WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    return rows[0] ? toAdminRow(rows[0]) : null;
  }

  async list(filter: {
    tenantId: string;
    scope?: MarkupRuleScope;
    accountId?: string;
    supplierHotelId?: string;
    accountType?: AccountType;
    status?: 'ACTIVE' | 'INACTIVE';
    limit?: number;
    offset?: number;
  }): Promise<ReadonlyArray<MarkupRuleAdminRow>> {
    const limit = filter.limit ?? 100;
    const offset = filter.offset ?? 0;
    const { rows } = await this.pool.query<DbRow>(
      `
      SELECT * FROM pricing_markup_rule
       WHERE tenant_id = $1
         AND ($2::text IS NULL OR scope = $2)
         AND ($3::char(26) IS NULL OR account_id = $3)
         AND ($4::char(26) IS NULL OR supplier_hotel_id = $4)
         AND ($5::text IS NULL OR account_type = $5)
         AND ($6::text IS NULL OR status = $6)
       ORDER BY created_at DESC
       LIMIT $7 OFFSET $8
      `,
      [
        filter.tenantId,
        filter.scope ?? null,
        filter.accountId ?? null,
        filter.supplierHotelId ?? null,
        filter.accountType ?? null,
        filter.status ?? null,
        limit,
        offset,
      ],
    );
    return rows.map(toAdminRow);
  }

  /**
   * Patch the mutable fields. Scope, scope-key fields, tenant, and
   * markup_kind are intentionally absent — those are create-time-only
   * because changing them either breaks the discriminated-union
   * CHECK or changes the rule's identity.
   */
  async patch(
    id: string,
    tenantId: string,
    patch: {
      percentValue?: string;
      priority?: number;
      validFrom?: string | null;
      validTo?: string | null;
      status?: 'ACTIVE' | 'INACTIVE';
    },
  ): Promise<MarkupRuleAdminRow> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `
        UPDATE pricing_markup_rule
           SET percent_value = COALESCE($3::numeric(7,4), percent_value),
               priority      = COALESCE($4::integer,     priority),
               valid_from    = CASE WHEN $5::boolean THEN $6::timestamptz
                                    ELSE valid_from END,
               valid_to      = CASE WHEN $7::boolean THEN $8::timestamptz
                                    ELSE valid_to END,
               status        = COALESCE($9::text,        status),
               updated_at    = now()
         WHERE id = $1 AND tenant_id = $2
         RETURNING *
        `,
        [
          id,
          tenantId,
          patch.percentValue ?? null,
          patch.priority ?? null,
          patch.validFrom !== undefined,
          patch.validFrom ?? null,
          patch.validTo !== undefined,
          patch.validTo ?? null,
          patch.status ?? null,
        ],
      );
      if (rows.length === 0) {
        throw new NotFoundException(`pricing_markup_rule ${id} not found`);
      }
      return toAdminRow(rows[0]!);
    } catch (err) {
      throw translatePgError(err);
    }
  }

  /**
   * Soft delete via status='INACTIVE'. We never DROP rows because
   * they may be referenced by older pricing traces; keeping them
   * INACTIVE preserves audit while removing them from the live
   * search-time evaluator (which filters on `status = 'ACTIVE'`).
   */
  async softDelete(id: string, tenantId: string): Promise<MarkupRuleAdminRow> {
    return this.patch(id, tenantId, { status: 'INACTIVE' });
  }
}

function toAdminRow(r: DbRow): MarkupRuleAdminRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    scope: r.scope,
    accountId: r.account_id,
    supplierHotelId: r.supplier_hotel_id,
    accountType: r.account_type,
    markupKind: r.markup_kind,
    percentValue: r.percent_value,
    priority: r.priority,
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
    // foreign_key_violation
    return new ConflictException(
      `Referenced row does not exist: ${e.constraint ?? 'foreign key'}`,
    );
  }
  if (e.code === '23514') {
    // check_violation — most likely the scope discriminated-union check
    return new ConflictException(
      `Constraint violated: ${e.constraint ?? 'check'}`,
    );
  }
  return err as Error;
}
