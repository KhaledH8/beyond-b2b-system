import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Pool } from '@bb/db';
import { PG_POOL } from '../database/database.module';

export interface ContractAdminRow {
  readonly id: string;
  readonly tenantId: string;
  readonly canonicalHotelId: string;
  readonly supplierId: string;
  readonly contractCode: string;
  readonly currency: string;
  readonly validFrom: string | null;
  readonly validTo: string | null;
  readonly status: 'DRAFT' | 'ACTIVE' | 'INACTIVE';
  readonly version: number;
  readonly parentContractId: string | null;
  readonly signedDocRef: string | null;
  readonly notes: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface DbRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly canonical_hotel_id: string;
  readonly supplier_id: string;
  readonly contract_code: string;
  readonly currency: string;
  readonly valid_from: string | null;
  readonly valid_to: string | null;
  readonly status: 'DRAFT' | 'ACTIVE' | 'INACTIVE';
  readonly version: number;
  readonly parent_contract_id: string | null;
  readonly signed_doc_ref: string | null;
  readonly notes: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

@Injectable()
export class ContractRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async insert(row: {
    id: string;
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
  }): Promise<ContractAdminRow> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `INSERT INTO rate_auth_contract (
           id, tenant_id, canonical_hotel_id, supplier_id,
           contract_code, currency,
           valid_from, valid_to, status, version,
           parent_contract_id, signed_doc_ref, notes
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8::date, 'DRAFT', 1, $9, $10, $11)
         RETURNING *`,
        [
          row.id,
          row.tenantId,
          row.canonicalHotelId,
          row.supplierId,
          row.contractCode,
          row.currency,
          row.validFrom ?? null,
          row.validTo ?? null,
          row.parentContractId ?? null,
          row.signedDocRef ?? null,
          row.notes ?? null,
        ],
      );
      return toRow(rows[0]!);
    } catch (err) {
      throw translatePgError(err);
    }
  }

  async findById(
    id: string,
    tenantId: string,
  ): Promise<ContractAdminRow | null> {
    const { rows } = await this.pool.query<DbRow>(
      `SELECT * FROM rate_auth_contract WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    return rows[0] ? toRow(rows[0]) : null;
  }

  async list(filter: {
    tenantId: string;
    canonicalHotelId?: string;
    status?: 'DRAFT' | 'ACTIVE' | 'INACTIVE';
    limit?: number;
    offset?: number;
  }): Promise<ReadonlyArray<ContractAdminRow>> {
    const limit = filter.limit ?? 100;
    const offset = filter.offset ?? 0;
    const { rows } = await this.pool.query<DbRow>(
      `SELECT * FROM rate_auth_contract
        WHERE tenant_id = $1
          AND ($2::char(26) IS NULL OR canonical_hotel_id = $2)
          AND ($3::text IS NULL OR status = $3)
        ORDER BY created_at DESC
        LIMIT $4 OFFSET $5`,
      [
        filter.tenantId,
        filter.canonicalHotelId ?? null,
        filter.status ?? null,
        limit,
        offset,
      ],
    );
    return rows.map(toRow);
  }

  async patch(
    id: string,
    tenantId: string,
    patch: {
      contractCode?: string;
      currency?: string;
      validFrom?: string | null;
      validTo?: string | null;
      status?: 'ACTIVE' | 'INACTIVE';
      signedDocRef?: string | null;
      notes?: string | null;
    },
  ): Promise<ContractAdminRow> {
    try {
      const { rows } = await this.pool.query<DbRow>(
        `UPDATE rate_auth_contract
            SET contract_code  = COALESCE($3,            contract_code),
                currency       = COALESCE($4,            currency),
                valid_from     = CASE WHEN $5::boolean   THEN $6::date ELSE valid_from     END,
                valid_to       = CASE WHEN $7::boolean   THEN $8::date ELSE valid_to       END,
                status         = COALESCE($9,            status),
                signed_doc_ref = CASE WHEN $10::boolean  THEN $11      ELSE signed_doc_ref END,
                notes          = CASE WHEN $12::boolean  THEN $13      ELSE notes          END,
                updated_at     = now()
          WHERE id = $1 AND tenant_id = $2
          RETURNING *`,
        [
          id,
          tenantId,
          patch.contractCode ?? null,
          patch.currency ?? null,
          patch.validFrom !== undefined,
          patch.validFrom ?? null,
          patch.validTo !== undefined,
          patch.validTo ?? null,
          patch.status ?? null,
          patch.signedDocRef !== undefined,
          patch.signedDocRef ?? null,
          patch.notes !== undefined,
          patch.notes ?? null,
        ],
      );
      if (rows.length === 0) throw new NotFoundException(`contract ${id} not found`);
      return toRow(rows[0]!);
    } catch (err) {
      throw translatePgError(err);
    }
  }
}

function toRow(r: DbRow): ContractAdminRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    canonicalHotelId: r.canonical_hotel_id,
    supplierId: r.supplier_id,
    contractCode: r.contract_code,
    currency: r.currency,
    validFrom: r.valid_from,
    validTo: r.valid_to,
    status: r.status,
    version: r.version,
    parentContractId: r.parent_contract_id,
    signedDocRef: r.signed_doc_ref,
    notes: r.notes,
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
