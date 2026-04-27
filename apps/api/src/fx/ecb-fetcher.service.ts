import { Inject, Injectable } from '@nestjs/common';
import {
  FxRateSnapshotRepository,
  type FxRateSnapshotInput,
} from './fx-rate-snapshot.repository';
import { newUlid } from '../common/ulid';

const ECB_URL =
  'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';

const DATE_RE = /[Cc]ube\s+time=['"](\d{4}-\d{2}-\d{2})['"]/;
const PAIR_RE =
  /[Cc]ube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"]([0-9.]+)['"]/g;

export interface ParsedEcbXml {
  readonly observedAt: string;
  readonly pairs: ReadonlyArray<{
    baseCurrency: string;
    quoteCurrency: string;
    rate: string;
  }>;
}

export function parseEcbXml(xml: string): ParsedEcbXml {
  const dateMatch = DATE_RE.exec(xml);
  if (!dateMatch) throw new Error('ECB XML: could not find publication date');

  const observedAt = `${dateMatch[1]}T00:00:00Z`;
  const pairs: { baseCurrency: string; quoteCurrency: string; rate: string }[] =
    [];

  PAIR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PAIR_RE.exec(xml)) !== null) {
    pairs.push({ baseCurrency: 'EUR', quoteCurrency: m[1]!, rate: m[2]! });
  }

  return { observedAt, pairs };
}

export interface EcbSyncResult {
  readonly provider: 'ECB';
  readonly observedAt: string;
  readonly pairsTotal: number;
  readonly pairsInserted: number;
}

@Injectable()
export class EcbFetcherService {
  constructor(
    @Inject(FxRateSnapshotRepository)
    private readonly repository: FxRateSnapshotRepository,
  ) {}

  async sync(): Promise<EcbSyncResult> {
    const response = await fetch(ECB_URL);
    if (!response.ok) {
      throw new Error(
        `ECB fetch failed: ${response.status} ${response.statusText}`,
      );
    }

    const xml = await response.text();
    const { observedAt, pairs } = parseEcbXml(xml);

    const inputs: FxRateSnapshotInput[] = pairs.map((p) => ({
      id: newUlid(),
      provider: 'ECB',
      baseCurrency: p.baseCurrency,
      quoteCurrency: p.quoteCurrency,
      rate: p.rate,
      observedAt,
    }));

    const { inserted } = await this.repository.upsertBatch(inputs);

    return {
      provider: 'ECB',
      observedAt,
      pairsTotal: pairs.length,
      pairsInserted: inserted,
    };
  }
}
