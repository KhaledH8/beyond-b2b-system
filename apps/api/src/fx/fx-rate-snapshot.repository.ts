import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from '@bb/db';
import type { FxSnapshot } from '@bb/fx';
import { PG_POOL } from '../database/database.module';

export interface FxRateSnapshotInput {
  readonly id: string;
  readonly provider: string;
  readonly baseCurrency: string;
  readonly quoteCurrency: string;
  readonly rate: string;
  readonly observedAt: string;
}

/**
 * `FxSnapshot` plus the DB id, so audit-write callers can record which
 * snapshot a conversion derived from (`fx_application.rate_snapshot_id`,
 * ADR-024 C4). Structurally a superset of `FxSnapshot`, so the same row
 * can be passed straight to `applyFx` without copying.
 */
export interface FxSnapshotWithId extends FxSnapshot {
  readonly id: string;
}

interface FxRateSnapshotRow {
  readonly id: string;
  readonly provider: string;
  readonly base_currency: string;
  readonly quote_currency: string;
  readonly rate: string;
  readonly observed_at: Date | string;
}

function rowToSnapshot(row: FxRateSnapshotRow): FxSnapshotWithId {
  const observedAt =
    row.observed_at instanceof Date
      ? row.observed_at.toISOString()
      : new Date(row.observed_at).toISOString();
  return {
    id: row.id,
    provider: row.provider,
    baseCurrency: row.base_currency,
    quoteCurrency: row.quote_currency,
    rate: row.rate,
    observedAt,
  };
}

@Injectable()
export class FxRateSnapshotRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * Idempotent multi-row insert. Rows that already exist for the same
   * (provider, base_currency, quote_currency, observed_at) are skipped
   * via ON CONFLICT DO NOTHING. Returns the count actually inserted.
   */
  async upsertBatch(
    inputs: ReadonlyArray<FxRateSnapshotInput>,
  ): Promise<{ inserted: number }> {
    if (inputs.length === 0) return { inserted: 0 };

    const values: unknown[] = [];
    const placeholders: string[] = [];

    inputs.forEach((input, i) => {
      const b = i * 6;
      placeholders.push(
        `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}::numeric, $${b + 6}::timestamptz)`,
      );
      values.push(
        input.id,
        input.provider,
        input.baseCurrency,
        input.quoteCurrency,
        input.rate,
        input.observedAt,
      );
    });

    const sql = `
      INSERT INTO fx_rate_snapshot
        (id, provider, base_currency, quote_currency, rate, observed_at)
      VALUES ${placeholders.join(', ')}
      ON CONFLICT (provider, base_currency, quote_currency, observed_at) DO NOTHING
      RETURNING id
    `;

    const { rows } = await this.pool.query<{ id: string }>(sql, values);
    return { inserted: rows.length };
  }

  /**
   * Returns every snapshot for `provider` whose `observed_at` is no
   * older than `freshnessTtlMinutes` measured back from `asOf`. Rows are
   * mapped to the pure `FxSnapshot` shape consumed by `@bb/fx` so the
   * caller can hand the array straight to `applyFx`.
   *
   * The result is intentionally provider-scoped: the cross-rate path in
   * `applyFx` only mixes snapshots from one feed at a time, never a
   * cocktail of OXR + ECB rows.
   */
  async findFreshSnapshots(
    provider: string,
    asOf: Date,
    freshnessTtlMinutes: number,
  ): Promise<FxSnapshotWithId[]> {
    const cutoff = new Date(
      asOf.getTime() - freshnessTtlMinutes * 60_000,
    ).toISOString();
    const sql = `
      SELECT id, provider, base_currency, quote_currency, rate, observed_at
      FROM fx_rate_snapshot
      WHERE provider = $1 AND observed_at >= $2::timestamptz
      ORDER BY observed_at DESC
    `;
    const { rows } = await this.pool.query<FxRateSnapshotRow>(sql, [
      provider,
      cutoff,
    ]);
    return rows.map(rowToSnapshot);
  }
}
