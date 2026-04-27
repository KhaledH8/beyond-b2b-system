import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Pool, PoolClient } from '@bb/db';
import { PG_POOL } from '../database/database.module';

export interface CancellationPolicyAdminRow {
  readonly id: string;
  readonly tenantId: string;
  readonly supplierId: string;
  readonly canonicalHotelId: string;
  readonly ratePlanId: string | null;
  readonly contractId: string | null;
  readonly policyVersion: number;
  readonly windowsJsonb: ReadonlyArray<unknown>;
  readonly refundable: boolean;
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
  readonly contract_id: string | null;
  readonly policy_version: number;
  readonly windows_jsonb: ReadonlyArray<unknown>;
  readonly refundable: boolean;
  readonly effective_from: Date;
  readonly effective_to: Date | null;
  readonly superseded_by_id: string | null;
  readonly created_at: Date;
}

export interface InsertCancellationPolicyInput {
  readonly id: string;
  readonly tenantId: string;
  readonly supplierId: string;
  readonly canonicalHotelId: string;
  readonly ratePlanId: string | null;
  readonly contractId: string | null;
  readonly windowsJsonb: ReadonlyArray<unknown>;
  readonly refundable: boolean;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
}

export interface SupersedeResult {
  readonly oldRow: CancellationPolicyAdminRow;
  readonly newRow: CancellationPolicyAdminRow;
}

/**
 * Repository for `rate_auth_cancellation_policy`.
 *
 * Both `create` and `supersede` are transactional. They lock a parent
 * row (the contract for contract-scoped writes, the supplier for
 * supplier-default writes) before computing `MAX(policy_version)` so
 * concurrent writes within the same scope cannot both observe the
 * same max and produce duplicate versions.
 *
 * The supplier-row lock is wider than strictly necessary (it
 * serializes all supplier-default writes for one supplier across all
 * hotels and rate plans). For Phase B the write volume is small;
 * narrowing to a per-`(supplier, hotel, rate_plan)` advisory lock can
 * land later if it ever becomes a contention issue.
 *
 * No `delete` method (ADR-023 D8). The only mutation is the
 * `UPDATE … SET superseded_by_id` step inside `supersede()`.
 */
@Injectable()
export class CancellationPolicyRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async create(input: InsertCancellationPolicyInput): Promise<CancellationPolicyAdminRow> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.lockParent(client, input);
      const version = await this.computeNextVersion(client, input);
      const row = await this.insertWithClient(client, input, version);
      await client.query('COMMIT');
      return row;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw translatePgError(err);
    } finally {
      client.release();
    }
  }

  async supersede(args: {
    oldId: string;
    requireContractId?: string | null;
    newRow: InsertCancellationPolicyInput;
  }): Promise<SupersedeResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Lock the old row first so we observe and update it atomically.
      const { rows: oldRows } = await client.query<DbRow>(
        `SELECT * FROM rate_auth_cancellation_policy WHERE id = $1 FOR UPDATE`,
        [args.oldId],
      );
      if (oldRows.length === 0) {
        throw new NotFoundException(`cancellation policy ${args.oldId} not found`);
      }
      const oldRowDb = oldRows[0]!;
      if (oldRowDb.superseded_by_id !== null) {
        throw new ConflictException(
          `cancellation policy ${args.oldId} is already superseded by ${oldRowDb.superseded_by_id}`,
        );
      }
      if (args.requireContractId !== undefined) {
        if (oldRowDb.contract_id !== (args.requireContractId ?? null)) {
          throw new NotFoundException(
            `cancellation policy ${args.oldId} not found in the requested scope`,
          );
        }
      }

      // Then lock the parent row to serialize MAX-version computation
      // for the new row's scope. The new row inherits the same scope
      // shape so this is the same parent in all real cases.
      await this.lockParent(client, args.newRow);
      const version = await this.computeNextVersion(client, args.newRow);
      const newRowDb = await this.insertWithClient(client, args.newRow, version);

      await client.query(
        `UPDATE rate_auth_cancellation_policy
            SET superseded_by_id = $1
          WHERE id = $2`,
        [newRowDb.id, oldRowDb.id],
      );

      await client.query('COMMIT');
      return {
        oldRow: { ...toRow(oldRowDb), supersededById: newRowDb.id },
        newRow: newRowDb,
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
  ): Promise<CancellationPolicyAdminRow | null> {
    const { rows } = await this.pool.query<DbRow>(
      `SELECT * FROM rate_auth_cancellation_policy
        WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    return rows[0] ? toRow(rows[0]) : null;
  }

  async findContractScopedById(
    id: string,
    contractId: string,
  ): Promise<CancellationPolicyAdminRow | null> {
    const { rows } = await this.pool.query<DbRow>(
      `SELECT * FROM rate_auth_cancellation_policy
        WHERE id = $1 AND contract_id = $2`,
      [id, contractId],
    );
    return rows[0] ? toRow(rows[0]) : null;
  }

  async listForContract(
    contractId: string,
    opts: { includeSuperseded?: boolean } = {},
  ): Promise<ReadonlyArray<CancellationPolicyAdminRow>> {
    const includeSuperseded = opts.includeSuperseded ?? false;
    const { rows } = await this.pool.query<DbRow>(
      `SELECT * FROM rate_auth_cancellation_policy
        WHERE contract_id = $1
          AND ($2::boolean OR superseded_by_id IS NULL)
        ORDER BY policy_version DESC, created_at ASC`,
      [contractId, includeSuperseded],
    );
    return rows.map(toRow);
  }

  async listSupplierDefault(args: {
    tenantId: string;
    supplierId: string;
    canonicalHotelId: string;
    ratePlanId?: string;
    includeSuperseded?: boolean;
  }): Promise<ReadonlyArray<CancellationPolicyAdminRow>> {
    const includeSuperseded = args.includeSuperseded ?? false;
    const { rows } = await this.pool.query<DbRow>(
      `SELECT * FROM rate_auth_cancellation_policy
        WHERE tenant_id = $1
          AND supplier_id = $2
          AND canonical_hotel_id = $3
          AND contract_id IS NULL
          AND ($4::char(26) IS NULL OR rate_plan_id = $4)
          AND ($5::boolean OR superseded_by_id IS NULL)
        ORDER BY policy_version DESC, created_at ASC`,
      [
        args.tenantId,
        args.supplierId,
        args.canonicalHotelId,
        args.ratePlanId ?? null,
        includeSuperseded,
      ],
    );
    return rows.map(toRow);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async lockParent(
    client: PoolClient,
    input: InsertCancellationPolicyInput,
  ): Promise<void> {
    if (input.contractId !== null) {
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM rate_auth_contract
          WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [input.contractId, input.tenantId],
      );
      if (rows.length === 0) {
        throw new NotFoundException(`contract ${input.contractId} not found`);
      }
      return;
    }
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM supply_supplier WHERE id = $1 FOR UPDATE`,
      [input.supplierId],
    );
    if (rows.length === 0) {
      throw new NotFoundException(`supplier ${input.supplierId} not found`);
    }
  }

  private async computeNextVersion(
    client: PoolClient,
    scope: InsertCancellationPolicyInput,
  ): Promise<number> {
    const { rows } = await client.query<{ max_version: number | null }>(
      `SELECT MAX(policy_version) AS max_version
         FROM rate_auth_cancellation_policy
        WHERE tenant_id = $1
          AND supplier_id = $2
          AND canonical_hotel_id = $3
          AND rate_plan_id IS NOT DISTINCT FROM $4::char(26)
          AND contract_id  IS NOT DISTINCT FROM $5::char(26)`,
      [
        scope.tenantId,
        scope.supplierId,
        scope.canonicalHotelId,
        scope.ratePlanId,
        scope.contractId,
      ],
    );
    const max = rows[0]?.max_version ?? 0;
    return max + 1;
  }

  private async insertWithClient(
    client: PoolClient,
    input: InsertCancellationPolicyInput,
    version: number,
  ): Promise<CancellationPolicyAdminRow> {
    const { rows } = await client.query<DbRow>(
      `INSERT INTO rate_auth_cancellation_policy (
         id, tenant_id, supplier_id, canonical_hotel_id,
         rate_plan_id, contract_id,
         policy_version, windows_jsonb, refundable,
         effective_from, effective_to
       )
       VALUES (
         $1, $2, $3, $4,
         $5, $6,
         $7, $8::jsonb, $9,
         $10::timestamptz, $11::timestamptz
       )
       RETURNING *`,
      [
        input.id,
        input.tenantId,
        input.supplierId,
        input.canonicalHotelId,
        input.ratePlanId,
        input.contractId,
        version,
        JSON.stringify(input.windowsJsonb),
        input.refundable,
        input.effectiveFrom,
        input.effectiveTo,
      ],
    );
    return toRow(rows[0]!);
  }
}

function toRow(r: DbRow): CancellationPolicyAdminRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    supplierId: r.supplier_id,
    canonicalHotelId: r.canonical_hotel_id,
    ratePlanId: r.rate_plan_id,
    contractId: r.contract_id,
    policyVersion: r.policy_version,
    windowsJsonb: r.windows_jsonb,
    refundable: r.refundable,
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
