import type { TenantContext, Money } from '@bb/domain';

export type BenchmarkSource =
  | 'RATEGAIN_DATALABS'
  | 'OTA_INSIGHT'
  | 'LIGHTHOUSE'
  | 'INTERNAL_SCRAPER';

/**
 * A point-in-time public-rate snapshot for a hotel on given dates.
 * Advisory only — never a sellable rate, never authoritative (ADR-015).
 */
export interface BenchmarkSnapshot {
  readonly id: string;
  readonly tenantId: string;
  readonly canonicalHotelId: string;
  readonly checkIn: string;
  readonly checkOut: string;
  readonly source: BenchmarkSource;
  readonly referencePrice: Money;
  readonly snapshotAt: Date;
}

export interface BenchmarkQuery {
  readonly canonicalHotelId: string;
  readonly checkIn: string;
  readonly checkOut: string;
  readonly currency?: string;
}

/**
 * Read-only port. Pricing reads this; rate-intelligence never reads pricing.
 * Direction is enforced by the ESLint dependency-direction rules.
 */
export interface BenchmarkReadPort {
  getLatestSnapshot(
    ctx: TenantContext,
    query: BenchmarkQuery,
  ): Promise<BenchmarkSnapshot | undefined>;
  getSnapshotHistory(
    ctx: TenantContext,
    query: BenchmarkQuery,
    limit: number,
  ): Promise<ReadonlyArray<BenchmarkSnapshot>>;
}
