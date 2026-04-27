import { Inject, Injectable } from '@nestjs/common';
import type { Money } from '@bb/domain';
import {
  applyFx,
  findFreshestSnapshot,
  type ApplyFxResult,
  type FxConfig,
  type FxSnapshot,
} from '@bb/fx';
import {
  FxRateSnapshotRepository,
  type FxSnapshotWithId,
} from './fx-rate-snapshot.repository';

/**
 * OXR primary config.
 *
 * Defaults assume the free plan (USD pivot, hourly publish). Paid-plan
 * upgrade is a config change only:
 *
 *   - `OXR_FRESHNESS_MINUTES` — drop from 60 to e.g. 5 if upgrading to a
 *      plan that publishes every minute.
 *   - `OXR_BASE_CURRENCY`     — change from USD to whatever pivot the
 *      paid plan uses.
 */
function loadOxrFxConfig(): FxConfig {
  return {
    freshnessTtlMinutes: parsePositiveInt(
      process.env['OXR_FRESHNESS_MINUTES'],
      60,
    ),
    pivotCurrency: process.env['OXR_BASE_CURRENCY'] ?? 'USD',
    preferredProvider: 'OXR',
  };
}

/**
 * ECB fallback config.
 *
 * ECB publishes once per business day (1440 min). EUR is the only pivot
 * the ECB feed exposes, so this is not configurable.
 */
function loadEcbFxConfig(): FxConfig {
  return {
    freshnessTtlMinutes: parsePositiveInt(
      process.env['ECB_FRESHNESS_MINUTES'],
      1440,
    ),
    pivotCurrency: 'EUR',
    preferredProvider: 'ECB',
  };
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(
      `Invalid FX env value "${raw}": expected a positive integer`,
    );
  }
  return n;
}

/**
 * Per-conversion result returned by `BatchConverter.convert`. Identical
 * shape to `ApplyFxResult` but enriched with `snapshotIds` so the
 * audit-write step can record which snapshots produced the rate.
 *
 * For DIRECT and INVERSE there is exactly one snapshot id. For
 * CROSS_RATE there are two (pivot→source and pivot→target). The schema
 * `fx_application.rate_snapshot_id` is single-valued (ADR-024 C1), so
 * the C4 audit writer records DIRECT/INVERSE only and skips CROSS_RATE
 * — the displayPrice still appears for the user; the audit row is
 * deferred to a follow-up that extends the schema.
 */
export type FxRateConversion =
  | {
      readonly converted: true;
      readonly displayAmount: Money;
      readonly appliedRate: string;
      readonly provider: string;
      readonly observedAt: string;
      readonly method: 'DIRECT' | 'INVERSE' | 'CROSS_RATE';
      readonly pivotCurrency?: string;
      readonly snapshotIds: ReadonlyArray<string>;
    }
  | {
      readonly converted: false;
      readonly reason: 'SAME_CURRENCY' | 'NO_RATE';
    };

/**
 * In-memory two-tier converter that pre-loads OXR + ECB snapshots
 * once per request. Each `convert` call is synchronous and zero-DB.
 *
 * The batch shape exists because search responses can carry tens of
 * rates: doing one `findFreshSnapshots` round-trip per rate would
 * dominate the latency. `FxRateService.loadConverter` runs the two
 * lookups once; this object then services every per-rate conversion
 * from memory.
 */
export class BatchConverter {
  constructor(
    private readonly oxr: ReadonlyArray<FxSnapshotWithId>,
    private readonly ecb: ReadonlyArray<FxSnapshotWithId>,
    private readonly asOf: Date,
    private readonly oxrConfig: FxConfig,
    private readonly ecbConfig: FxConfig,
  ) {}

  convert(source: Money, toCurrency: string): FxRateConversion {
    if (source.currency === toCurrency) {
      return { converted: false, reason: 'SAME_CURRENCY' };
    }

    const oxrResult = applyFx(
      source,
      toCurrency,
      this.oxr,
      this.asOf,
      this.oxrConfig,
    );
    if (oxrResult.converted) {
      return this.attachIds(oxrResult, source, toCurrency, this.oxr, this.oxrConfig);
    }

    const ecbResult = applyFx(
      source,
      toCurrency,
      this.ecb,
      this.asOf,
      this.ecbConfig,
    );
    if (ecbResult.converted) {
      return this.attachIds(ecbResult, source, toCurrency, this.ecb, this.ecbConfig);
    }

    return { converted: false, reason: 'NO_RATE' };
  }

  private attachIds(
    result: Extract<ApplyFxResult, { converted: true }>,
    source: Money,
    toCurrency: string,
    snapshots: ReadonlyArray<FxSnapshotWithId>,
    cfg: FxConfig,
  ): FxRateConversion {
    const ttl = cfg.freshnessTtlMinutes;
    const provider = cfg.preferredProvider;
    const ids: string[] = [];
    if (result.method === 'DIRECT') {
      const s = pickWithId(
        findFreshestSnapshot(snapshots, provider, source.currency, toCurrency, this.asOf, ttl),
      );
      if (s) ids.push(s.id);
    } else if (result.method === 'INVERSE') {
      const s = pickWithId(
        findFreshestSnapshot(snapshots, provider, toCurrency, source.currency, this.asOf, ttl),
      );
      if (s) ids.push(s.id);
    } else {
      // CROSS_RATE — pivot→source and pivot→target legs.
      const pivot = result.pivotCurrency ?? cfg.pivotCurrency;
      const fromS = pickWithId(
        findFreshestSnapshot(snapshots, provider, pivot, source.currency, this.asOf, ttl),
      );
      const toS = pickWithId(
        findFreshestSnapshot(snapshots, provider, pivot, toCurrency, this.asOf, ttl),
      );
      if (fromS) ids.push(fromS.id);
      if (toS) ids.push(toS.id);
    }
    return {
      converted: true,
      displayAmount: result.displayAmount,
      appliedRate: result.appliedRate,
      provider: result.provider,
      observedAt: result.observedAt,
      method: result.method,
      ...(result.pivotCurrency !== undefined ? { pivotCurrency: result.pivotCurrency } : {}),
      snapshotIds: ids,
    };
  }
}

/**
 * `findFreshestSnapshot` returns `FxSnapshot | undefined`. We pass
 * `FxSnapshotWithId[]` in, so the runtime object DOES carry `id` —
 * this helper just narrows the static type without copying.
 */
function pickWithId(
  snap: FxSnapshot | undefined,
): FxSnapshotWithId | undefined {
  return snap as FxSnapshotWithId | undefined;
}

/**
 * Two-tier display-FX lookup.
 *
 * Tier 1: OXR (commercial / live). Hourly freshness on the free plan,
 *         USD pivot. Tried first because it tracks the rate a reseller
 *         would actually transact at.
 * Tier 2: ECB (reference / official). Daily freshness, EUR pivot. Used
 *         only when OXR has no fresh snapshot for the pair — typically
 *         when the OXR sync has been stalled (paused, quota exhausted,
 *         outage) for longer than its TTL.
 *
 * Tiers are independent: if OXR returns a fresh DIRECT rate, ECB is
 * never consulted. If OXR is stale or missing the pair, we fall through
 * to ECB and try again. Both attempts go through the same pure
 * `applyFx` so DIRECT → INVERSE → CROSS_RATE precedence is identical
 * across providers.
 *
 * Result is for **display only** (ADR-024 D6) — never written to a
 * `LedgerEntry`, never used as a pricing input.
 */
@Injectable()
export class FxRateService {
  private readonly oxrConfig: FxConfig;
  private readonly ecbConfig: FxConfig;

  constructor(
    @Inject(FxRateSnapshotRepository)
    private readonly repository: FxRateSnapshotRepository,
  ) {
    this.oxrConfig = loadOxrFxConfig();
    this.ecbConfig = loadEcbFxConfig();
  }

  async convert(
    source: Money,
    toCurrency: string,
    asOf: Date = new Date(),
  ): Promise<ApplyFxResult> {
    if (source.currency === toCurrency) {
      return { converted: false, reason: 'SAME_CURRENCY' };
    }

    const oxrSnapshots = await this.repository.findFreshSnapshots(
      'OXR',
      asOf,
      this.oxrConfig.freshnessTtlMinutes,
    );
    const oxrResult = applyFx(
      source,
      toCurrency,
      oxrSnapshots,
      asOf,
      this.oxrConfig,
    );
    if (oxrResult.converted) return oxrResult;

    const ecbSnapshots = await this.repository.findFreshSnapshots(
      'ECB',
      asOf,
      this.ecbConfig.freshnessTtlMinutes,
    );
    return applyFx(
      source,
      toCurrency,
      ecbSnapshots,
      asOf,
      this.ecbConfig,
    );
  }

  /**
   * Pre-fetch OXR + ECB snapshots in two parallel queries and return a
   * `BatchConverter` for in-memory per-rate conversion. Use when a
   * single request needs to convert many rates (e.g. a search response).
   */
  async loadConverter(asOf: Date = new Date()): Promise<BatchConverter> {
    const [oxr, ecb] = await Promise.all([
      this.repository.findFreshSnapshots(
        'OXR',
        asOf,
        this.oxrConfig.freshnessTtlMinutes,
      ),
      this.repository.findFreshSnapshots(
        'ECB',
        asOf,
        this.ecbConfig.freshnessTtlMinutes,
      ),
    ]);
    return new BatchConverter(
      oxr,
      ecb,
      asOf,
      this.oxrConfig,
      this.ecbConfig,
    );
  }

  /**
   * OXR-only variant for booking-time FX lock fallback (ADR-024 C5).
   *
   * The booking-time lock provider set is restricted to STRIPE and OXR
   * by schema CHECK (`booking_fx_lock_provider_chk`). ECB's daily
   * publish cadence is incompatible with a card-charge contract, so
   * the C5 resolver must NOT consult ECB even though the search-time
   * service does. This method bakes that restriction into the call
   * site by passing an empty ECB array to `BatchConverter`, so any
   * `convert()` that misses OXR returns `NO_RATE` rather than silently
   * falling through to ECB.
   *
   * Search code keeps using `loadConverter` (both tiers).
   */
  async loadOxrOnlyConverter(
    asOf: Date = new Date(),
  ): Promise<BatchConverter> {
    const oxr = await this.repository.findFreshSnapshots(
      'OXR',
      asOf,
      this.oxrConfig.freshnessTtlMinutes,
    );
    return new BatchConverter(
      oxr,
      [],
      asOf,
      this.oxrConfig,
      this.ecbConfig,
    );
  }
}
