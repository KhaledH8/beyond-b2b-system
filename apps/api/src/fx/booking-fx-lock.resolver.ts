import { Inject, Injectable } from '@nestjs/common';
import {
  StripeFxQuoteClient,
  type StripeFxQuoteResponse,
} from './stripe-fx-quote.client';
import { FxRateService } from './fx-rate.service';

/**
 * Resolves a booking-time FX lock decision (ADR-024 C5).
 *
 * The decision tree is locked by C5 plan + accepted corrections:
 *
 *   1. source == charge currency      → NO_LOCK_NEEDED
 *   2. Stripe FX Quote succeeds       → STRIPE_FX_QUOTE
 *   3. Stripe fails, OXR has a fresh
 *      snapshot for the pair          → SNAPSHOT_REFERENCE (provider=OXR)
 *   4. Stripe fails, OXR also misses  → NO_LOCK_AVAILABLE
 *                                       (caller proceeds in source
 *                                       currency, writes no lock row)
 *
 * **ECB is intentionally excluded.** The schema CHECK
 * `booking_fx_lock_provider_chk` only allows ('STRIPE', 'OXR'); the
 * fallback uses `FxRateService.loadOxrOnlyConverter`, which loads OXR
 * snapshots only and never consults ECB even if ECB rows exist for
 * the pair. ECB remains a search-time / reference-only fallback.
 *
 * This is a **decision producer**, not a writer. C5b ends here:
 * `BookingFxLockRepository.insert` is the writer, but the saga that
 * orchestrates resolve → insert → snapshot pinning in one transaction
 * is C5c. Keeping the decision pure also keeps the unit tests pure —
 * no DB, no Nest test module.
 */

export type BookingFxLockDecision =
  | { readonly kind: 'NO_LOCK_NEEDED'; readonly reason: 'SAME_CURRENCY' }
  | {
      readonly kind: 'NO_LOCK_AVAILABLE';
      readonly reason: 'STRIPE_FAILED_AND_NO_OXR_SNAPSHOT';
      readonly stripeError?: string;
    }
  | {
      readonly kind: 'STRIPE_FX_QUOTE';
      readonly provider: 'STRIPE';
      readonly sourceCurrency: string;
      readonly chargeCurrency: string;
      readonly sourceMinor: bigint;
      readonly chargeMinor: bigint;
      /** 1 source = N charge, 8 decimals. Inverted from Stripe's wire rate. */
      readonly rate: string;
      readonly providerQuoteId: string;
      readonly expiresAt: string;
    }
  | {
      readonly kind: 'SNAPSHOT_REFERENCE';
      readonly provider: 'OXR';
      readonly sourceCurrency: string;
      readonly chargeCurrency: string;
      readonly sourceMinor: bigint;
      readonly chargeMinor: bigint;
      readonly rate: string;
      readonly rateSnapshotId: string;
    };

export interface BookingFxLockResolveInput {
  readonly sourceCurrency: string;
  readonly chargeCurrency: string;
  readonly sourceMinor: bigint;
  /** Defaults to `new Date()` at resolve time. */
  readonly asOf?: Date;
}

@Injectable()
export class BookingFxLockResolver {
  constructor(
    @Inject(StripeFxQuoteClient)
    private readonly stripe: StripeFxQuoteClient,
    @Inject(FxRateService)
    private readonly fxRate: FxRateService,
  ) {}

  async resolve(
    input: BookingFxLockResolveInput,
  ): Promise<BookingFxLockDecision> {
    const { sourceCurrency, chargeCurrency, sourceMinor } = input;
    const asOf = input.asOf ?? new Date();

    if (sourceCurrency === chargeCurrency) {
      return { kind: 'NO_LOCK_NEEDED', reason: 'SAME_CURRENCY' };
    }

    // Tier 1: Stripe FX Quote. Any Stripe error (network, 4xx, 5xx,
    // missing-rate parse failure) drops to tier 2.
    let stripeError: string | undefined;
    try {
      const quote = await this.stripe.fetchQuote({
        fromCurrency: chargeCurrency,
        toCurrency: sourceCurrency,
      });
      return buildStripeDecision({
        quote,
        sourceCurrency,
        chargeCurrency,
        sourceMinor,
      });
    } catch (err) {
      stripeError = err instanceof Error ? err.message : 'unknown Stripe error';
    }

    // Tier 2: OXR-only snapshot reference. ECB is excluded by
    // construction — `loadOxrOnlyConverter` passes an empty ECB array.
    const converter = await this.fxRate.loadOxrOnlyConverter(asOf);
    const conv = converter.convert(
      { amount: '1', currency: sourceCurrency },
      chargeCurrency,
    );
    // Only DIRECT and INVERSE map to a single auditable snapshot. The
    // booking_fx_lock schema's `rate_snapshot_id` is single-valued
    // (NOT NULL when lock_kind='SNAPSHOT_REFERENCE'); CROSS_RATE has
    // two snapshot legs and cannot be honestly attributed to one row,
    // so it degrades to NO_LOCK_AVAILABLE here. Search-time displayPrice
    // is unaffected — that path tolerates CROSS_RATE without an audit
    // row (C4 already documents the same gap).
    if (conv.converted && conv.method !== 'CROSS_RATE') {
      const snapshotId = conv.snapshotIds[0];
      if (snapshotId) {
        const rate = conv.appliedRate;
        const chargeMinor = applyRateToMinor(sourceMinor, rate);
        return {
          kind: 'SNAPSHOT_REFERENCE',
          provider: 'OXR',
          sourceCurrency,
          chargeCurrency,
          sourceMinor,
          chargeMinor,
          rate,
          rateSnapshotId: snapshotId,
        };
      }
    }

    return {
      kind: 'NO_LOCK_AVAILABLE',
      reason: 'STRIPE_FAILED_AND_NO_OXR_SNAPSHOT',
      ...(stripeError !== undefined ? { stripeError } : {}),
    };
  }
}

function buildStripeDecision(args: {
  readonly quote: StripeFxQuoteResponse;
  readonly sourceCurrency: string;
  readonly chargeCurrency: string;
  readonly sourceMinor: bigint;
}): BookingFxLockDecision {
  // Stripe wire rate semantics: 1 from(charge) = exchangeRate × to(source).
  // Our schema's `rate` is "1 source = N charge", which is the inverse.
  const stripeRate = parseFloat(args.quote.exchangeRate);
  if (!Number.isFinite(stripeRate) || stripeRate <= 0) {
    throw new Error(
      `Stripe FX Quote returned an unusable exchange_rate: "${args.quote.exchangeRate}"`,
    );
  }
  const ourRate = (1 / stripeRate).toFixed(8);
  const chargeMinor = applyRateToMinor(args.sourceMinor, ourRate);
  return {
    kind: 'STRIPE_FX_QUOTE',
    provider: 'STRIPE',
    sourceCurrency: args.sourceCurrency,
    chargeCurrency: args.chargeCurrency,
    sourceMinor: args.sourceMinor,
    chargeMinor,
    rate: ourRate,
    providerQuoteId: args.quote.id,
    expiresAt: args.quote.lockExpiresAt,
  };
}

/**
 * Multiplies a minor-unit `bigint` by an 8-decimal rate string and
 * rounds half-away-from-zero to a whole minor unit.
 *
 * Implementation rationale: the rate is at most 8 decimals; we scale
 * to integer arithmetic (rate × 10^8) and use BigInt division so we
 * never lose precision on large amounts. Float multiplication would
 * be acceptable here in isolation (booking amounts fit comfortably in
 * Number's safe-integer range) but the bigint path is cheap and keeps
 * the audit reconstructible to the last unit.
 */
function applyRateToMinor(sourceMinor: bigint, rate: string): bigint {
  const scale = 100_000_000n; // 10^8
  const rateScaled = parseRateToScaledBigInt(rate);
  // chargeMinor = round(sourceMinor × rate) where rate is fraction
  // (rateScaled / 10^8). Half-away-from-zero rounding via:
  //   floor((|x| × 2 + denominator) / (denominator × 2)) × sign
  const numerator = sourceMinor * rateScaled;
  return roundHalfAwayFromZero(numerator, scale);
}

function parseRateToScaledBigInt(rate: string): bigint {
  if (!/^-?\d+(\.\d{1,8})?$/.test(rate)) {
    throw new Error(`Invalid rate "${rate}": expected up to 8 decimal places`);
  }
  const negative = rate.startsWith('-');
  const abs = negative ? rate.slice(1) : rate;
  const [whole = '0', fractionRaw = ''] = abs.split('.');
  const fraction = (fractionRaw + '00000000').slice(0, 8);
  const scaled = BigInt(whole + fraction);
  return negative ? -scaled : scaled;
}

function roundHalfAwayFromZero(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n;
  const abs = negative ? -numerator : numerator;
  const halfUp = (abs * 2n + denominator) / (denominator * 2n);
  return negative ? -halfUp : halfUp;
}
