import { type Money, minorUnitExponent } from '@bb/domain';
import { type FxSnapshot, findFreshestSnapshot } from './rate-lookup';
import { deriveCrossRate } from './cross-rate';

export interface FxConfig {
  /**
   * How many minutes a snapshot remains fresh enough to use.
   *
   * OXR free plan publishes hourly  →  60
   * ECB publishes daily             →  1440
   *
   * Upgrading from the OXR free plan to a paid plan that publishes more
   * frequently only requires changing this value — no code change.
   */
  readonly freshnessTtlMinutes: number;

  /**
   * The pivot currency used by the provider.
   *
   * OXR free plan:  'USD'  (all snapshots are USD-base)
   * ECB:            'EUR'  (all snapshots are EUR-base)
   * OXR paid plan:  configurable per account
   *
   * When source or target IS the pivot currency, `applyFx` reaches the
   * direct or inverse path before the cross-rate path, so no special
   * handling is needed for those cases.
   */
  readonly pivotCurrency: string;

  /**
   * Preferred provider to try first. `undefined` accepts any provider
   * (first fresh match wins). Set to `'OXR'` or `'ECB'` to enforce a
   * preference — useful for callers that want the commercial rate rather
   * than the ECB reference.
   */
  readonly preferredProvider?: string;
}

export type ApplyFxResult =
  | {
      readonly converted: true;
      readonly displayAmount: Money;
      /** The effective rate as an 8-decimal-place string. */
      readonly appliedRate: string;
      readonly provider: string;
      readonly observedAt: string;
      readonly method: 'DIRECT' | 'INVERSE' | 'CROSS_RATE';
      /** Populated only when method === 'CROSS_RATE'. */
      readonly pivotCurrency?: string;
    }
  | {
      readonly converted: false;
      readonly reason: 'SAME_CURRENCY' | 'NO_RATE';
    };

/**
 * Applies an FX rate to convert `source` into `toCurrency` for display.
 *
 * Lookup strategy (in order):
 *   1. DIRECT     — snapshot where base=source.currency, quote=toCurrency
 *   2. INVERSE    — snapshot where base=toCurrency, quote=source.currency
 *                   (appliedRate = 1 / snapshot.rate)
 *   3. CROSS_RATE — two snapshots sharing the pivot currency
 *                   (appliedRate = pivotToTo.rate / pivotToFrom.rate)
 *
 * Returns `converted: false` when:
 *   - source and target are the same currency ('SAME_CURRENCY')
 *   - no fresh snapshot exists for any lookup strategy ('NO_RATE')
 *
 * **The result is a display amount only.** It must never be written to a
 * LedgerEntry, used as a pricing input, or treated as authoritative for
 * settlement (ADR-024 D6). The ledger always records source-currency cost.
 */
export function applyFx(
  source: Money,
  toCurrency: string,
  snapshots: ReadonlyArray<FxSnapshot>,
  asOf: Date,
  config: FxConfig,
): ApplyFxResult {
  if (source.currency === toCurrency) {
    return { converted: false, reason: 'SAME_CURRENCY' };
  }

  const { freshnessTtlMinutes, pivotCurrency, preferredProvider: prov } = config;

  // 1. DIRECT: base=source.currency, quote=toCurrency
  const direct = findFreshestSnapshot(
    snapshots,
    prov,
    source.currency,
    toCurrency,
    asOf,
    freshnessTtlMinutes,
  );
  if (direct) {
    return {
      converted: true,
      displayAmount: convertAmount(source.amount, direct.rate, toCurrency),
      appliedRate: direct.rate,
      provider: direct.provider,
      observedAt: direct.observedAt,
      method: 'DIRECT',
    };
  }

  // 2. INVERSE: base=toCurrency, quote=source.currency → rate = 1/r
  const inverse = findFreshestSnapshot(
    snapshots,
    prov,
    toCurrency,
    source.currency,
    asOf,
    freshnessTtlMinutes,
  );
  if (inverse) {
    const inverseRate = (1 / parseFloat(inverse.rate)).toFixed(8);
    return {
      converted: true,
      displayAmount: convertAmount(source.amount, inverseRate, toCurrency),
      appliedRate: inverseRate,
      provider: inverse.provider,
      observedAt: inverse.observedAt,
      method: 'INVERSE',
    };
  }

  // 3. CROSS_RATE: pivot→source and pivot→target must both be fresh
  const pivotToFrom = findFreshestSnapshot(
    snapshots,
    prov,
    pivotCurrency,
    source.currency,
    asOf,
    freshnessTtlMinutes,
  );
  const pivotToTo = findFreshestSnapshot(
    snapshots,
    prov,
    pivotCurrency,
    toCurrency,
    asOf,
    freshnessTtlMinutes,
  );
  if (pivotToFrom && pivotToTo) {
    const cross = deriveCrossRate(pivotToFrom, pivotToTo);
    return {
      converted: true,
      displayAmount: convertAmount(source.amount, cross.rate, toCurrency),
      appliedRate: cross.rate,
      provider: cross.provider,
      observedAt: cross.observedAt,
      method: 'CROSS_RATE',
      pivotCurrency: cross.pivotCurrency,
    };
  }

  return { converted: false, reason: 'NO_RATE' };
}

/**
 * Multiplies a decimal-string amount by a decimal-string rate and returns
 * a `Money` value rounded to the target currency's minor-unit precision.
 * Float arithmetic is acceptable here: the result is a display price, not
 * a ledger entry (ADR-024 D6).
 *
 * Uses the shared `minorUnitExponent` from `@bb/domain` so the
 * zero-decimal-currency table never drifts between `@bb/pricing` and
 * `@bb/fx`.
 */
function convertAmount(
  sourceAmount: string,
  rate: string,
  toCurrency: string,
): Money {
  const raw = parseFloat(sourceAmount) * parseFloat(rate);
  const exp = minorUnitExponent(toCurrency);
  const factor = Math.pow(10, exp);
  const minor = Math.round(raw * factor);
  const amount =
    exp === 0 ? minor.toString() : (minor / factor).toFixed(exp);
  return { amount, currency: toCurrency };
}
