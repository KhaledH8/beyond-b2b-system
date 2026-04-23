import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from '@bb/db';
import type { SupplierRegistrationPort } from '@bb/adapter-hotelbeds';
import { PG_POOL } from '../../database/database.module';
import { newUlid } from '../../common/ulid';

/**
 * Concrete DB-backed implementation of the Hotelbeds
 * `SupplierRegistrationPort` (ADR-003 / ADR-013).
 *
 * `supply_supplier.source_type` is the legacy AGGREGATOR | DIRECT
 * axis. Hotelbeds is always AGGREGATOR; ingestionMode (PULL/PUSH/HYBRID)
 * is a *different* axis that will land on `supply_supplier` in a
 * follow-up migration. For now we preserve the legacy column's
 * semantics and ignore the ingestion mode at the row level — the
 * adapter still declares PULL in its static meta, which is what the
 * pricing pipeline reads.
 */
@Injectable()
export class PgSupplierRegistrationPort implements SupplierRegistrationPort {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async upsertSupplier(row: {
    readonly supplierId: string;
    readonly displayName: string;
    readonly ingestionMode: 'PULL' | 'PUSH' | 'HYBRID';
  }): Promise<void> {
    // `supplierId` from the adapter is the string code ("hotelbeds");
    // the DB primary key is a ULID. Upsert on `code` so repeated
    // calls are idempotent and the ULID is allocated exactly once.
    await this.pool.query(
      `
      INSERT INTO supply_supplier (id, code, display_name, source_type, status)
      VALUES ($1, $2, $3, 'AGGREGATOR', 'ACTIVE')
      ON CONFLICT (code) DO UPDATE
        SET display_name = EXCLUDED.display_name,
            updated_at   = now()
      `,
      [newUlid(), row.supplierId, row.displayName],
    );
  }
}
