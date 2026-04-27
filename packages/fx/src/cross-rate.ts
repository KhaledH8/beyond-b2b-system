import type { FxSnapshot } from './rate-lookup';

export interface CrossRateResult {
  /** Derived from→to rate as an 8-decimal-place string. */
  readonly rate: string;
  /** The shared pivot currency (e.g. 'USD' for OXR, 'EUR' for ECB). */
  readonly pivotCurrency: string;
  /** Provider of the underlying snapshots (taken from pivotToTo). */
  readonly provider: string;
  /**
   * Effective observedAt for the derived rate — the minimum of the two
   * component snapshots' observedAt, because the cross-rate is only as
   * fresh as its stalest input.
   */
  readonly observedAt: string;
}

/**
 * Derives a from→to rate via a shared pivot currency.
 *
 * Given:
 *   pivotToFrom: 1 pivot = r1 from  (e.g. base=USD quote=EUR rate=0.92)
 *   pivotToTo:   1 pivot = r2 to    (e.g. base=USD quote=GBP rate=0.78)
 *
 * Then:  1 from = (r2 / r1) to  →  EUR/GBP = 0.78 / 0.92 ≈ 0.84783
 *
 * Precondition: pivotToFrom.baseCurrency === pivotToTo.baseCurrency.
 * The caller (applyFx) guarantees this by looking up both with the same
 * pivotCurrency parameter.
 */
export function deriveCrossRate(
  pivotToFrom: FxSnapshot,
  pivotToTo: FxSnapshot,
): CrossRateResult {
  const r1 = parseFloat(pivotToFrom.rate);
  const r2 = parseFloat(pivotToTo.rate);
  const derived = r2 / r1;

  const fromMs = new Date(pivotToFrom.observedAt).getTime();
  const toMs = new Date(pivotToTo.observedAt).getTime();
  const observedAt =
    fromMs <= toMs ? pivotToFrom.observedAt : pivotToTo.observedAt;

  return {
    rate: derived.toFixed(8),
    pivotCurrency: pivotToFrom.baseCurrency,
    provider: pivotToTo.provider,
    observedAt,
  };
}
