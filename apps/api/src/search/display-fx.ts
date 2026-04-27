import type {
  CurrencyCode,
  DisplayPriceApplied,
  Money,
  SearchResponseFxApplication,
  SearchResultHotel,
  SearchResultRate,
} from '@bb/domain';
import type { FxRateConversion } from '../fx/fx-rate.service';
import type { FxApplicationInput } from '../fx/fx-application.repository';
import { newUlid } from '../common/ulid';

/**
 * Minimal converter surface this helper depends on. Decoupled from the
 * concrete `BatchConverter` so tests can pass a hand-built fake without
 * mocking the FX repository.
 */
export interface DisplayFxConverter {
  convert(source: Money, toCurrency: string): FxRateConversion;
}

export interface DisplayFxOutcome {
  /** Hotels with `displayPrice` attached where conversion succeeded. */
  readonly results: SearchResultHotel[];
  readonly meta: SearchResponseFxApplication;
  /**
   * Deduplicated `fx_application` rows ready for batch insert.
   * CROSS_RATE conversions are intentionally excluded — see comment
   * on `FxRateConversion` re: the schema's single-snapshot column.
   */
  readonly applications: FxApplicationInput[];
}

interface BuildDisplayFxArgs {
  readonly results: ReadonlyArray<SearchResultHotel>;
  readonly displayCurrency: CurrencyCode;
  readonly searchId: string;
  readonly converter: DisplayFxConverter;
}

/**
 * Walks every rate, converts via the supplied converter when source
 * currency differs from the requested display currency, and produces:
 *
 *   - `results` — a new array of hotels with `displayPrice` attached
 *      to each rate where conversion succeeded
 *   - `meta`    — `SearchResponseFxApplication` summarising the run
 *      (status, providers, counts)
 *   - `applications` — deduplicated `fx_application` inputs to write
 *      to the audit table
 *
 * Pure: no DB, no clock, no `Date.now()`. Determinism makes the unit
 * tests trivial.
 *
 * Same-currency rates are excluded from `ratesNeedingConversion` and
 * never get a `displayPrice` (it would be a redundant copy of
 * `priceQuote.sellingPrice`). Status semantics:
 *
 *   APPLIED  — every rate that needed conversion got `displayPrice`,
 *              OR no rate needed conversion (request matched source).
 *   PARTIAL  — some converted, some did not.
 *   DEGRADED — at least one rate needed conversion AND none succeeded.
 */
export function buildDisplayFx(args: BuildDisplayFxArgs): DisplayFxOutcome {
  const { results, displayCurrency, searchId, converter } = args;

  const newResults: SearchResultHotel[] = [];
  const providers = new Set<string>();
  const dedup = new Map<string, FxApplicationInput>();
  let needing = 0;
  let converted = 0;

  for (const hotel of results) {
    const newRates: SearchResultRate[] = [];
    for (const rate of hotel.rates) {
      const sellingPrice = rate.priceQuote.sellingPrice;
      if (sellingPrice.currency === displayCurrency) {
        // Same-currency: not "needing conversion", no displayPrice
        // attached to avoid redundant payload.
        newRates.push(rate);
        continue;
      }
      needing += 1;
      const conv = converter.convert(sellingPrice, displayCurrency);
      if (!conv.converted) {
        // NO_RATE — degrade for this rate, leave displayPrice off.
        newRates.push(rate);
        continue;
      }
      converted += 1;
      providers.add(conv.provider);

      const displayPrice: DisplayPriceApplied = {
        amount: conv.displayAmount,
        rate: conv.appliedRate,
        provider: conv.provider,
        method: conv.method,
        observedAt: conv.observedAt,
        ...(conv.pivotCurrency !== undefined
          ? { pivotCurrency: conv.pivotCurrency }
          : {}),
      };
      newRates.push({ ...rate, displayPrice });

      // Dedup audit rows. The schema's `rate_snapshot_id` is single-
      // valued; CROSS_RATE has two snapshot legs so we cannot honestly
      // attribute it to one row in this slice — skip the audit write
      // (the `displayPrice` still appears on the rate; the audit gap
      // is a known C4 limitation).
      if (conv.method === 'CROSS_RATE') continue;
      const snapshotId = conv.snapshotIds[0];
      if (!snapshotId) continue;
      const key = `${sellingPrice.currency}::${snapshotId}`;
      if (!dedup.has(key)) {
        dedup.set(key, {
          id: newUlid(),
          provider: conv.provider,
          sourceCurrency: sellingPrice.currency,
          displayCurrency,
          rate: conv.appliedRate,
          rateSnapshotId: snapshotId,
          applicationKind: 'SEARCH',
          requestCorrelationRef: searchId,
        });
      }
    }
    newResults.push({ ...hotel, rates: newRates });
  }

  let status: 'APPLIED' | 'PARTIAL' | 'DEGRADED';
  if (needing === 0) status = 'APPLIED';
  else if (converted === needing) status = 'APPLIED';
  else if (converted === 0) status = 'DEGRADED';
  else status = 'PARTIAL';

  const meta: SearchResponseFxApplication = {
    requestedDisplayCurrency: displayCurrency,
    status,
    providers: Array.from(providers).sort(),
    ratesNeedingConversion: needing,
    ratesConverted: converted,
  };

  return {
    results: newResults,
    meta,
    applications: Array.from(dedup.values()),
  };
}
