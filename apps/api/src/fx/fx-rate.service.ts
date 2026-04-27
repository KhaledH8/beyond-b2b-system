import { Inject, Injectable } from '@nestjs/common';
import type { Money } from '@bb/domain';
import { applyFx, type ApplyFxResult, type FxConfig } from '@bb/fx';
import { FxRateSnapshotRepository } from './fx-rate-snapshot.repository';

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
}
