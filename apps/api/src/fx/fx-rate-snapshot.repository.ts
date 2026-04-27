import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from '@bb/db';
import { PG_POOL } from '../database/database.module';

export interface FxRateSnapshotInput {
  readonly id: string;
  readonly provider: string;
  readonly baseCurrency: string;
  readonly quoteCurrency: string;
  readonly rate: string;
  readonly observedAt: string;
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
}
