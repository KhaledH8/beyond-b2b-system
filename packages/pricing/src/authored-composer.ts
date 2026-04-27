import type {
  AccountContext,
  AppliedMarkup,
  GrossCurrencySemantics,
  MarkupRuleSnapshot,
  Money,
  MoneyMovementTriple,
  PricingTraceStep,
} from '@bb/domain';
import { applyPercentMarkup, fromMinorUnits } from './money';
import { pickRule, type EvaluatedOffer } from './evaluator';

/**
 * Pure pricing evaluator for AUTHORED_PRIMITIVES offers (ADR-021, ADR-022).
 *
 * Inputs are an in-memory `PriceableAuthoredOffer` that has already been
 * assembled from `rate_auth_*` rows by a future DB assembly layer, the
 * markup rules applicable to the request, and the account context. No DB,
 * no IO — the composer is a function of its arguments so it can be unit
 * tested and audited without a stack.
 *
 * The composer trusts the input shape — it does not look up rate plans,
 * room types, occupancy templates, or child age bands. It does enforce that
 * the per-night coverage is well-formed: exactly `(checkOut - checkIn)`
 * nightly entries, sorted, contiguous, and with non-negative amounts.
 *
 * Trace step kinds emitted, in order:
 *   1. AUTHORED_BASE_RATE — always (the offer's load-bearing primitive).
 *   2. AUTHORED_OCCUPANCY_SUPPLEMENT — only when total > 0.
 *   3. AUTHORED_MEAL_SUPPLEMENT — only when total > 0.
 *   4. COLLECTION_AND_SETTLEMENT_BIND — when `moneyMovement` is provided.
 *   5. MARKUP_APPLIED — when a rule matches via `pickRule` precedence.
 *
 * Markup precedence (CLAUDE.md §5) is reused unchanged via `pickRule` from
 * the sourced evaluator. The HOTEL-scope match key is `supplierHotelId`,
 * which the assembly layer resolves from the contract's supplier + hotel
 * mapping. The composer treats it as opaque.
 *
 * Provenance + shape labelling (ADR-021): authored offers MUST be wrapped
 * by the search-result builder with `offerShape = AUTHORED_PRIMITIVES` and
 * a non-provisional `moneyMovementProvenance` (i.e. CONFIG_RESOLVED, never
 * PROVISIONAL — the contract is configured, not derived from a payload).
 * The composer exports `AUTHORED_OFFER_SHAPE` as the canonical literal.
 *
 * What this composer deliberately does NOT do (yet):
 *   - Restrictions / availability gating (ADR-023, Phase B).
 *   - Cancellation policy resolution (ADR-023, Phase B).
 *   - Tax / fee composition.
 *   - Currency conversion.
 *   - Promotions.
 */

export const AUTHORED_OFFER_SHAPE = 'AUTHORED_PRIMITIVES' as const;

export interface AuthoredNightLine {
  /** Stay date in ISO YYYY-MM-DD. Must be contiguous with neighbors. */
  readonly stayDate: string;
  /** Base room rate for this night, in minor units of the offer currency. */
  readonly baseRateMinorUnits: bigint;
  /** Pre-aggregated occupancy supplement total for this night across all matching slots / occupants. */
  readonly occupancySupplementMinorUnits: bigint;
  /** Pre-aggregated meal supplement total for this night across all matching occupants. */
  readonly mealSupplementMinorUnits: bigint;
}

export interface PriceableAuthoredOffer {
  /** Resolved by the DB assembly layer from the contract's supplier + canonical hotel mapping. Match key for HOTEL-scope markup rules. */
  readonly supplierHotelId: string;
  readonly currency: string;
  /** Inclusive of `checkIn`, exclusive of `checkOut` — same convention as the booking domain. */
  readonly checkIn: string;
  readonly checkOut: string;
  /** Exactly `(checkOut - checkIn)` entries, sorted ascending and contiguous starting at `checkIn`. */
  readonly nights: ReadonlyArray<AuthoredNightLine>;
  /** ADR-004 / ADR-020: when present, a COLLECTION_AND_SETTLEMENT_BIND step is appended after the authored chain. */
  readonly moneyMovement?: MoneyMovementTriple;
  readonly grossCurrencySemantics?: GrossCurrencySemantics;
}

export function evaluateAuthoredOffer(
  offer: PriceableAuthoredOffer,
  rules: ReadonlyArray<MarkupRuleSnapshot>,
  ctx: AccountContext,
): EvaluatedOffer {
  validateInput(offer);

  const baseTotal = sum(offer.nights, (n) => n.baseRateMinorUnits);
  const occTotal = sum(offer.nights, (n) => n.occupancySupplementMinorUnits);
  const mealTotal = sum(offer.nights, (n) => n.mealSupplementMinorUnits);

  const steps: PricingTraceStep[] = [];

  let runningMinor = 0n;
  let runningMoney = money(0n, offer.currency);

  const afterBase = money(runningMinor + baseTotal, offer.currency);
  steps.push({
    kind: 'AUTHORED_BASE_RATE',
    before: runningMoney,
    after: afterBase,
    reason: `nights=${offer.nights.length} base=${afterBase.amount}`,
  });
  runningMinor += baseTotal;
  runningMoney = afterBase;

  if (occTotal > 0n) {
    const after = money(runningMinor + occTotal, offer.currency);
    steps.push({
      kind: 'AUTHORED_OCCUPANCY_SUPPLEMENT',
      before: runningMoney,
      after,
      reason: `nights=${offer.nights.length} occupancy=${money(occTotal, offer.currency).amount}`,
    });
    runningMinor += occTotal;
    runningMoney = after;
  }

  if (mealTotal > 0n) {
    const after = money(runningMinor + mealTotal, offer.currency);
    steps.push({
      kind: 'AUTHORED_MEAL_SUPPLEMENT',
      before: runningMoney,
      after,
      reason: `nights=${offer.nights.length} meal=${money(mealTotal, offer.currency).amount}`,
    });
    runningMinor += mealTotal;
    runningMoney = after;
  }

  const netMinor = runningMinor;
  const netMoney = runningMoney;

  if (offer.moneyMovement !== undefined) {
    steps.push({
      kind: 'COLLECTION_AND_SETTLEMENT_BIND',
      before: netMoney,
      after: netMoney,
      collectionMode: offer.moneyMovement.collectionMode,
      supplierSettlementMode: offer.moneyMovement.supplierSettlementMode,
      paymentCostModel: offer.moneyMovement.paymentCostModel,
      ...(offer.grossCurrencySemantics !== undefined
        ? { grossCurrencySemantics: offer.grossCurrencySemantics }
        : {}),
    });
  }

  const winning = pickRule(rules, ctx, offer.supplierHotelId);
  if (!winning) {
    return {
      priceQuote: { netCost: netMoney, sellingPrice: netMoney },
      trace: { steps, finalSellAmount: netMoney },
    };
  }

  const markupMinor = applyPercentMarkup(netMinor, winning.percentValue);
  const sellingMinor = netMinor + markupMinor;
  const sellingMoney = money(sellingMinor, offer.currency);
  const markupMoney = money(markupMinor, offer.currency);

  const appliedMarkup: AppliedMarkup = {
    ruleId: winning.id,
    scope: winning.scope,
    markupKind: 'PERCENT',
    percentValue: winning.percentValue,
    markupAmount: markupMoney,
  };

  steps.push({
    kind: 'MARKUP_APPLIED',
    before: netMoney,
    after: sellingMoney,
    ruleId: winning.id,
    reason: `scope=${winning.scope} percent=${winning.percentValue} priority=${winning.priority}`,
  });

  return {
    priceQuote: { netCost: netMoney, sellingPrice: sellingMoney, appliedMarkup },
    trace: { steps, finalSellAmount: sellingMoney },
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function money(minor: bigint, currency: string): Money {
  return { amount: fromMinorUnits(minor, currency), currency };
}

function sum<T>(arr: ReadonlyArray<T>, get: (x: T) => bigint): bigint {
  let s = 0n;
  for (const x of arr) s += get(x);
  return s;
}

function validateInput(offer: PriceableAuthoredOffer): void {
  if (offer.nights.length === 0) {
    throw new Error(
      'AuthoredComposer: nights must contain at least one entry',
    );
  }
  const checkIn = parseIsoDate(offer.checkIn, 'checkIn');
  const checkOut = parseIsoDate(offer.checkOut, 'checkOut');
  const expectedCount = daysBetween(checkIn, checkOut);
  if (expectedCount <= 0) {
    throw new Error(
      `AuthoredComposer: checkOut (${offer.checkOut}) must be strictly after checkIn (${offer.checkIn})`,
    );
  }
  if (offer.nights.length !== expectedCount) {
    throw new Error(
      `AuthoredComposer: nights count ${offer.nights.length} does not match stay length ${expectedCount} (checkIn=${offer.checkIn}, checkOut=${offer.checkOut})`,
    );
  }
  for (let i = 0; i < offer.nights.length; i++) {
    const n = offer.nights[i]!;
    const expected = formatIsoDate(addDays(checkIn, i));
    if (n.stayDate !== expected) {
      throw new Error(
        `AuthoredComposer: nights[${i}].stayDate=${n.stayDate} does not match expected ${expected}`,
      );
    }
    if (
      n.baseRateMinorUnits < 0n ||
      n.occupancySupplementMinorUnits < 0n ||
      n.mealSupplementMinorUnits < 0n
    ) {
      throw new Error(
        `AuthoredComposer: nights[${i}] contains a negative amount; minor-unit fields must be non-negative`,
      );
    }
  }
}

function parseIsoDate(s: string, label: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error(
      `AuthoredComposer: ${label} "${s}" is not ISO YYYY-MM-DD`,
    );
  }
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}

function addDays(date: Date, n: number): Date {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + n);
  return next;
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

function formatIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
