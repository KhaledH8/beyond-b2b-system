import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from '@bb/db';
import { PG_POOL } from '../database/database.module';

/**
 * Append-only audit row written for every FX conversion the platform
 * applies (ADR-024 C4). The schema is in C1's
 * `20260502000001_fx_rate_schema.ts`.
 *
 * Dedup is the caller's responsibility: per the schema doc, one row per
 * unique `(source_currency, display_currency, rate_snapshot_id)`
 * combination per request — *not* one row per converted rate. A search
 * with 50 rates that all use the same OXR USD→EUR snapshot writes one
 * row, not fifty.
 */
export interface FxApplicationInput {
  readonly id: string;
  readonly provider: string;
  readonly sourceCurrency: string;
  readonly displayCurrency: string;
  /** Effective rate (8-decimal string). For CROSS_RATE this is the derived rate, not a raw snapshot rate. */
  readonly rate: string;
  /** A stored snapshot id. NOT NULL per schema. */
  readonly rateSnapshotId: string;
  readonly applicationKind: 'SEARCH' | 'BOOKING_DISPLAY';
  /** searchId for SEARCH, bookingId for BOOKING_DISPLAY. */
  readonly requestCorrelationRef: string;
}

@Injectable()
export class FxApplicationRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async recordBatch(
    inputs: ReadonlyArray<FxApplicationInput>,
  ): Promise<{ inserted: number }> {
    if (inputs.length === 0) return { inserted: 0 };

    const values: unknown[] = [];
    const placeholders: string[] = [];

    inputs.forEach((input, i) => {
      const b = i * 8;
      placeholders.push(
        `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}::numeric, $${b + 6}, $${b + 7}, $${b + 8})`,
      );
      values.push(
        input.id,
        input.provider,
        input.sourceCurrency,
        input.displayCurrency,
        input.rate,
        input.rateSnapshotId,
        input.applicationKind,
        input.requestCorrelationRef,
      );
    });

    const sql = `
      INSERT INTO fx_application
        (id, provider, source_currency, display_currency, rate,
         rate_snapshot_id, application_kind, request_correlation_ref)
      VALUES ${placeholders.join(', ')}
      RETURNING id
    `;

    const { rows } = await this.pool.query<{ id: string }>(sql, values);
    return { inserted: rows.length };
  }
}
