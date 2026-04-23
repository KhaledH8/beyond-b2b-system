import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from '@bb/db';
import type { MappingPersistencePort } from '@bb/adapter-hotelbeds';
import { PG_POOL } from '../../database/database.module';
import { newUlid } from '../../common/ulid';

/**
 * Concrete writer for the four ADR-021 mapping tables:
 *   hotel_room_mapping, hotel_rate_plan_mapping,
 *   hotel_meal_plan_mapping, hotel_occupancy_mapping
 *
 * Every row lands as `status = 'PENDING', mapping_method = 'DETERMINISTIC'`
 * — the mapping pipeline (Phase 1 `packages/mapping/`, not yet built)
 * promotes them to CONFIRMED after it has resolved a canonical target.
 *
 * Hotel-scoped mapping inserts (`room`, `rate_plan`, `occupancy`)
 * reference `hotel_supplier.id` via FK. We resolve that ULID with an
 * `INSERT ... SELECT` that filters on the natural key; if the supplier
 * hotel has not yet been content-synced, the SELECT yields zero rows
 * and the insert is a safe no-op. Next content-sync + search cycle
 * will re-observe the mapping. This keeps the adapter write path from
 * failing when it observes a rate for a hotel the content pipeline
 * has not yet caught up on.
 *
 * ON CONFLICT on the partial unique index is written out explicitly
 * with the index predicate, which is the supported Postgres idiom for
 * targeting partial unique indexes (including the occupancy table's
 * expression-based `COALESCE(code, '')` index).
 */
@Injectable()
export class PgMappingPersistencePort implements MappingPersistencePort {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async upsertRoomMapping(params: {
    readonly supplierId: string;
    readonly supplierHotelId: string;
    readonly supplierRoomCode: string;
    readonly rawSignals: Record<string, unknown>;
  }): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO hotel_room_mapping (
        id, supplier_id, supplier_hotel_id, supplier_room_code, raw_signals
      )
      SELECT $1, s.id, hs.id, $3, $4::jsonb
      FROM supply_supplier s
      JOIN hotel_supplier hs
        ON hs.supplier_id = s.id
       AND hs.supplier_hotel_code = $5
      WHERE s.code = $2
      ON CONFLICT (supplier_id, supplier_hotel_id, supplier_room_code)
        WHERE status NOT IN ('REJECTED', 'SUPERSEDED')
      DO UPDATE SET raw_signals = EXCLUDED.raw_signals,
                    updated_at  = now()
      `,
      [
        newUlid(),
        params.supplierId,
        params.supplierRoomCode,
        JSON.stringify(params.rawSignals),
        params.supplierHotelId,
      ],
    );
  }

  async upsertRatePlanMapping(params: {
    readonly supplierId: string;
    readonly supplierHotelId: string;
    readonly supplierRateCode: string;
    readonly rawSignals: Record<string, unknown>;
  }): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO hotel_rate_plan_mapping (
        id, supplier_id, supplier_hotel_id, supplier_rate_code, raw_signals
      )
      SELECT $1, s.id, hs.id, $3, $4::jsonb
      FROM supply_supplier s
      JOIN hotel_supplier hs
        ON hs.supplier_id = s.id
       AND hs.supplier_hotel_code = $5
      WHERE s.code = $2
      ON CONFLICT (supplier_id, supplier_hotel_id, supplier_rate_code)
        WHERE status NOT IN ('REJECTED', 'SUPERSEDED')
      DO UPDATE SET raw_signals = EXCLUDED.raw_signals,
                    updated_at  = now()
      `,
      [
        newUlid(),
        params.supplierId,
        params.supplierRateCode,
        JSON.stringify(params.rawSignals),
        params.supplierHotelId,
      ],
    );
  }

  // Supplier-global: no hotel_supplier join, no supplier_hotel_id column.
  async upsertMealPlanMapping(params: {
    readonly supplierId: string;
    readonly supplierMealCode: string;
    readonly rawSignals: Record<string, unknown>;
  }): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO hotel_meal_plan_mapping (
        id, supplier_id, supplier_meal_code, raw_signals
      )
      SELECT $1, s.id, $3, $4::jsonb
      FROM supply_supplier s
      WHERE s.code = $2
      ON CONFLICT (supplier_id, supplier_meal_code)
        WHERE status NOT IN ('REJECTED', 'SUPERSEDED')
      DO UPDATE SET raw_signals = EXCLUDED.raw_signals,
                    updated_at  = now()
      `,
      [
        newUlid(),
        params.supplierId,
        params.supplierMealCode,
        JSON.stringify(params.rawSignals),
      ],
    );
  }

  // occupancy: partial unique index uses COALESCE(supplier_occupancy_code,'')
  // so the ON CONFLICT target repeats the expression verbatim.
  async upsertOccupancyMapping(params: {
    readonly supplierId: string;
    readonly supplierHotelId: string;
    readonly supplierOccupancyCode?: string;
    readonly rawSignals: Record<string, unknown>;
  }): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO hotel_occupancy_mapping (
        id, supplier_id, supplier_hotel_id, supplier_occupancy_code, raw_signals
      )
      SELECT $1, s.id, hs.id, $3, $4::jsonb
      FROM supply_supplier s
      JOIN hotel_supplier hs
        ON hs.supplier_id = s.id
       AND hs.supplier_hotel_code = $5
      WHERE s.code = $2
      ON CONFLICT (supplier_id, supplier_hotel_id, COALESCE(supplier_occupancy_code, ''))
        WHERE status NOT IN ('REJECTED', 'SUPERSEDED')
      DO UPDATE SET raw_signals = EXCLUDED.raw_signals,
                    updated_at  = now()
      `,
      [
        newUlid(),
        params.supplierId,
        params.supplierOccupancyCode ?? null,
        JSON.stringify(params.rawSignals),
        params.supplierHotelId,
      ],
    );
  }
}
