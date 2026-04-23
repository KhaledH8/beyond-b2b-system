import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from '@bb/db';
import type { TenantContext } from '@bb/domain';
import type { AdapterHotel } from '@bb/supplier-contract';
import type {
  HotelContentPersistencePort,
  RawPayloadRef,
} from '@bb/adapter-hotelbeds';
import { PG_POOL } from '../../database/database.module';
import { newUlid } from '../../common/ulid';

/**
 * Concrete `hotel_supplier` writer. One row per (supplier, supplier
 * hotel code); idempotent via the natural-key unique constraint.
 *
 * `canonical_hotel_id` stays NULL here — mapping belongs to the
 * separate pipeline, and the adapter must not guess. The row is an
 * observation.
 *
 * `raw_content` receives the per-hotel portion of the projected
 * `AdapterHotel`, not the full page payload. The full page is in
 * object storage (addressed by `rawPayload.storageRef`).
 */
@Injectable()
export class PgHotelContentPersistencePort implements HotelContentPersistencePort {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async upsertSupplierHotels(
    _ctx: TenantContext,
    params: {
      readonly hotels: ReadonlyArray<AdapterHotel>;
      readonly rawPayload: RawPayloadRef;
    },
  ): Promise<void> {
    if (params.hotels.length === 0) return;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Resolve supplier ULID once per batch. The adapter passes the
      // supplier string code on each hotel implicitly (Hotelbeds-only
      // port), so we look up by the known code and cache in-txn.
      const { rows: supplierRows } = await client.query<{ id: string }>(
        `SELECT id FROM supply_supplier WHERE code = $1`,
        ['hotelbeds'],
      );
      if (supplierRows.length === 0) {
        throw new Error(
          'supply_supplier row for hotelbeds missing — call ensureRegistered() first',
        );
      }
      const supplierDbId = supplierRows[0]!.id;

      for (const hotel of params.hotels) {
        const geo =
          hotel.lat !== undefined && hotel.lng !== undefined
            ? `ST_SetSRID(ST_MakePoint(${hotel.lng}, ${hotel.lat}), 4326)`
            : 'NULL';

        await client.query(
          `
          INSERT INTO hotel_supplier (
            id, supplier_id, supplier_hotel_code, name,
            address_country, geo, raw_content,
            content_refreshed_at
          )
          VALUES ($1, $2, $3, $4, $5, ${geo}, $6::jsonb, now())
          ON CONFLICT (supplier_id, supplier_hotel_code) DO UPDATE
            SET name                 = EXCLUDED.name,
                address_country      = EXCLUDED.address_country,
                geo                  = EXCLUDED.geo,
                raw_content          = EXCLUDED.raw_content,
                content_refreshed_at = now(),
                updated_at           = now()
          `,
          [
            newUlid(),
            supplierDbId,
            hotel.supplierHotelId,
            hotel.name,
            hotel.address.countryCode,
            JSON.stringify({
              address: hotel.address,
              starRating: hotel.starRating,
              chainCode: hotel.chainCode,
              rawPayloadRef: params.rawPayload,
            }),
          ],
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
