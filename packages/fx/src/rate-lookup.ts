/**
 * FX rate snapshot lookup — pure, no DB, no HTTP.
 *
 * The snapshot shape mirrors the `fx_rate_snapshot` DB table but is kept
 * independent of any DB library so this package can be used in any
 * execution context. Callers map DB rows to FxSnapshot before passing in.
 */

export interface FxSnapshot {
  readonly provider: string;       // 'OXR' | 'ECB'
  readonly baseCurrency: string;   // CHAR(3), e.g. 'USD' (OXR) or 'EUR' (ECB)
  readonly quoteCurrency: string;  // CHAR(3), e.g. 'EUR'
  readonly rate: string;           // NUMERIC(18,8) decimal string, e.g. '0.92000000'
  readonly observedAt: string;     // ISO 8601 UTC, e.g. '2025-04-27T00:00:00Z'
}

/**
 * Finds the freshest snapshot that matches the given provider (any if
 * `undefined`), base currency, and quote currency, where `observedAt`
 * falls within the freshness TTL measured back from `asOf`.
 *
 * Returns `undefined` when no matching fresh snapshot exists.
 */
export function findFreshestSnapshot(
  snapshots: ReadonlyArray<FxSnapshot>,
  provider: string | undefined,
  base: string,
  quote: string,
  asOf: Date,
  freshnessTtlMinutes: number,
): FxSnapshot | undefined {
  const cutoffMs = asOf.getTime() - freshnessTtlMinutes * 60 * 1000;

  let best: FxSnapshot | undefined;
  let bestMs = -Infinity;

  for (const s of snapshots) {
    if (provider !== undefined && s.provider !== provider) continue;
    if (s.baseCurrency !== base || s.quoteCurrency !== quote) continue;
    const observedMs = new Date(s.observedAt).getTime();
    if (observedMs < cutoffMs) continue;
    if (observedMs > bestMs) {
      best = s;
      bestMs = observedMs;
    }
  }

  return best;
}
