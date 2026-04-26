import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from '@bb/db';
import { PG_POOL } from '../database/database.module';

interface HotelSupplierRow {
  readonly id: string;
  readonly supplier_hotel_code: string;
}

/**
 * Resolves `(supplierCode, supplier_hotel_code)` → `hotel_supplier.id`
 * (ULID). Pricing rules and merchandising promotions key on the
 * `hotel_supplier.id` foreign key, but the search request carries the
 * supplier's own `supplier_hotel_code` (e.g. "1000073"). This
 * repository is the single translation point.
 *
 * Hotels not yet content-synced have no `hotel_supplier` row; they
 * are simply absent from the returned map. Pricing degrades to the
 * channel default (the only remaining match) and the search still
 * returns net-priced rates — the search seam never blocks on
 * unsynced inventory.
 */
@Injectable()
export class PgHotelSupplierRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async resolveCodes(
    supplierCode: string,
    supplierHotelCodes: ReadonlyArray<string>,
  ): Promise<ReadonlyMap<string, string>> {
    if (supplierHotelCodes.length === 0) {
      return new Map<string, string>();
    }
    const { rows } = await this.pool.query<HotelSupplierRow>(
      `
      SELECT hs.id, hs.supplier_hotel_code
        FROM hotel_supplier hs
        JOIN supply_supplier s ON s.id = hs.supplier_id
       WHERE s.code = $1
         AND hs.supplier_hotel_code = ANY($2::text[])
      `,
      [supplierCode, supplierHotelCodes as readonly string[]],
    );
    const out = new Map<string, string>();
    for (const row of rows) {
      out.set(row.supplier_hotel_code, row.id);
    }
    return out;
  }
}
