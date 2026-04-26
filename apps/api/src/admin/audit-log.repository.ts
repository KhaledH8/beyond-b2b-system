import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from '@bb/db';
import { PG_POOL } from '../database/database.module';
import { newUlid } from '../common/ulid';

export type AuditOperation = 'CREATE' | 'PATCH' | 'SOFT_DELETE';

export interface AuditEntry {
  readonly tenantId: string;
  readonly actorId: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly operation: AuditOperation;
  readonly payload: Record<string, unknown>;
}

/**
 * Append-only store for internal admin audit entries.
 * Rows in `admin_audit_log` are never updated or deleted.
 */
@Injectable()
export class AuditLogRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async write(entry: AuditEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO admin_audit_log
         (id, tenant_id, actor_id, resource_type, resource_id, operation, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        newUlid(),
        entry.tenantId,
        entry.actorId,
        entry.resourceType,
        entry.resourceId,
        entry.operation,
        JSON.stringify(entry.payload),
      ],
    );
  }
}
