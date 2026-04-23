import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from '@bb/db';
import type {
  SourcedOfferPersistencePort,
  SourcedOfferSnapshotInput,
  SourcedComponentInput,
  SourcedRestrictionInput,
  SourcedCancellationPolicyInput,
} from '@bb/adapter-hotelbeds';
import { PG_POOL } from '../../database/database.module';
import { newUlid } from '../../common/ulid';

/**
 * Concrete writer for the ADR-021 sourced-offer snapshot family:
 *   offer_sourced_snapshot
 *     └── offer_sourced_component       (0..N, populated only when
 *                                        supplier actually disclosed
 *                                        the breakdown — ADR-021
 *                                        invariant forbids fabrication)
 *     └── offer_sourced_restriction     (0..N, same rule)
 *     └── offer_sourced_cancellation_policy (0..1)
 *
 * All children live in the same transaction as the parent snapshot.
 * A failed child write rolls the snapshot back, so the table never
 * holds a half-written composed offer. The search session retries
 * either the whole rate or lets the rate drop — either outcome keeps
 * downstream reconciliation honest.
 */
@Injectable()
export class PgSourcedOfferPersistencePort implements SourcedOfferPersistencePort {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async recordSnapshot(input: SourcedOfferSnapshotInput): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

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

      await client.query(
        `
        INSERT INTO offer_sourced_snapshot (
          id, tenant_id, supplier_id, canonical_hotel_id,
          supplier_hotel_code, supplier_rate_key, search_session_id,
          check_in, check_out, occupancy_adults, occupancy_children_ages_jsonb,
          supplier_room_code, supplier_rate_code, supplier_meal_code,
          total_amount_minor_units, total_currency, rate_breakdown_granularity,
          valid_until,
          raw_payload_hash, raw_payload_storage_ref
        )
        VALUES (
          $1, $2, $3, $4,
          $5, $6, $7,
          $8::date, $9::date, $10, $11::jsonb,
          $12, $13, $14,
          $15, $16, $17,
          $18,
          $19, $20
        )
        `,
        [
          input.snapshotId,
          input.tenantId,
          supplierDbId,
          input.canonicalHotelId ?? null,
          input.supplierHotelCode,
          input.supplierRateKey,
          input.searchSessionId,
          input.checkIn,
          input.checkOut,
          input.occupancyAdults,
          JSON.stringify(input.occupancyChildrenAges),
          input.supplierRoomCode,
          input.supplierRateCode,
          input.supplierMealCode ?? null,
          // bigint → string for pg; the column is BIGINT and accepts
          // string-encoded integers without loss.
          input.totalAmountMinorUnits.toString(),
          input.totalCurrency,
          input.rateBreakdownGranularity,
          input.validUntil,
          input.rawPayload.hash,
          input.rawPayload.storageRef,
        ],
      );

      for (const c of input.components) {
        await this.insertComponent(client, input.snapshotId, c);
      }
      for (const r of input.restrictions) {
        await this.insertRestriction(client, input.snapshotId, r);
      }
      if (input.cancellationPolicy) {
        await this.insertCancellationPolicy(
          client,
          input.snapshotId,
          input.cancellationPolicy,
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

  private async insertComponent(
    client: PoolClient,
    snapshotId: string,
    c: SourcedComponentInput,
  ): Promise<void> {
    await client.query(
      `
      INSERT INTO offer_sourced_component (
        id, offer_snapshot_id, component_kind, description,
        amount_minor_units, currency, applies_to_night_date,
        applies_to_person_kind, inclusive
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8, $9)
      `,
      [
        newUlid(),
        snapshotId,
        c.componentKind,
        c.description ?? null,
        c.amountMinorUnits.toString(),
        c.currency,
        c.appliesToNightDate ?? null,
        c.appliesToPersonKind ?? null,
        c.inclusive,
      ],
    );
  }

  private async insertRestriction(
    client: PoolClient,
    snapshotId: string,
    r: SourcedRestrictionInput,
  ): Promise<void> {
    await client.query(
      `
      INSERT INTO offer_sourced_restriction (
        id, offer_snapshot_id, restriction_kind, params, source_verbatim_text
      )
      VALUES ($1, $2, $3, $4::jsonb, $5)
      `,
      [
        newUlid(),
        snapshotId,
        r.restrictionKind,
        JSON.stringify(r.params),
        r.sourceVerbatimText ?? null,
      ],
    );
  }

  private async insertCancellationPolicy(
    client: PoolClient,
    snapshotId: string,
    p: SourcedCancellationPolicyInput,
  ): Promise<void> {
    await client.query(
      `
      INSERT INTO offer_sourced_cancellation_policy (
        id, offer_snapshot_id, windows_jsonb, refundable,
        source_verbatim_text, parsed_with
      )
      VALUES ($1, $2, $3::jsonb, $4, $5, $6)
      `,
      [
        newUlid(),
        snapshotId,
        JSON.stringify(p.windows),
        p.refundable,
        p.sourceVerbatimText ?? null,
        p.parsedWith ?? null,
      ],
    );
  }
}
