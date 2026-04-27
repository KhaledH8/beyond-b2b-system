import { Inject, Injectable } from '@nestjs/common';
import {
  FxRateSnapshotRepository,
  type FxRateSnapshotInput,
} from './fx-rate-snapshot.repository';
import { OxrClient, type OxrLatestResponse } from './oxr-client';
import { newUlid } from '../common/ulid';

export interface OxrSyncResult {
  readonly provider: 'OXR';
  readonly baseCurrency: string;
  readonly observedAt: string;
  readonly pairsTotal: number;
  readonly pairsInserted: number;
}

/**
 * Pure mapping from an OXR `/latest.json` response to repository inputs.
 * Extracted so the transformation can be unit-tested without a network
 * mock or DB. The provider always stamps `OXR`; the base currency is
 * whatever the response declares (free plan: always USD).
 */
export function mapOxrToInputs(
  data: OxrLatestResponse,
  idFactory: () => string = newUlid,
): { observedAt: string; inputs: FxRateSnapshotInput[] } {
  const observedAt = new Date(data.timestamp * 1000).toISOString();
  const inputs: FxRateSnapshotInput[] = Object.entries(data.rates).map(
    ([quote, rate]) => ({
      id: idFactory(),
      provider: 'OXR',
      baseCurrency: data.base,
      quoteCurrency: quote,
      // NUMERIC(18,8) — store as a fixed-precision decimal string so the
      // float-encoded JSON value never surprises the DB column.
      rate: rate.toFixed(8),
      observedAt,
    }),
  );
  return { observedAt, inputs };
}

@Injectable()
export class OxrSyncService {
  constructor(
    @Inject(OxrClient) private readonly client: OxrClient,
    @Inject(FxRateSnapshotRepository)
    private readonly repository: FxRateSnapshotRepository,
  ) {}

  async sync(): Promise<OxrSyncResult> {
    const data = await this.client.fetchLatest();
    const { observedAt, inputs } = mapOxrToInputs(data);
    const { inserted } = await this.repository.upsertBatch(inputs);
    return {
      provider: 'OXR',
      baseCurrency: data.base,
      observedAt,
      pairsTotal: inputs.length,
      pairsInserted: inserted,
    };
  }
}
