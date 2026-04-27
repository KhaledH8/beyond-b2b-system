/**
 * Pure restriction evaluator (ADR-023, Phase B Slice B4).
 *
 * Inputs are an in-memory list of `RestrictionSnapshot` rows already
 * loaded from `rate_auth_restriction` by a caller (the search
 * assembly layer in Slice B5), the stay window, an explicit `now`,
 * and the request's `(contractId, seasonId, ratePlanId, roomTypeId)`
 * scope. Outputs a structured availability result. No DB, no IO,
 * no `Date.now()` — the evaluator is a function of its arguments so
 * it can be unit-tested and audited without a stack.
 *
 * Precedence (ADR-023 D4):
 *   tier 1 — `contract_id IS NOT NULL AND season_id IS NOT NULL`
 *   tier 2 — `contract_id IS NOT NULL AND season_id IS NULL`
 *   tier 3 — `contract_id IS NULL` (supplier-default)
 *   Higher tier wins per `(restriction_kind, stay_date)`. Within a
 *   tier, the lower `id` wins. The evaluator never combines rows
 *   across tiers — the most-specific tier with a candidate is the
 *   only one consulted for that kind/date.
 *
 * Date semantics (ADR-023 D3, with the user's CTD lock-in):
 *   STOP_SELL — a stay night equal to the row's `stay_date`.
 *   CTA      — `stay_date === checkIn`.
 *   CTD      — `stay_date === checkOut` (the actual checkout date).
 *   MIN_LOS / MAX_LOS                — keyed on `checkIn`.
 *   ADVANCE_PURCHASE_MIN / _MAX     — keyed on `checkIn`.
 *   RELEASE_HOURS / CUTOFF_HOURS    — keyed on `checkIn`.
 *
 * What the evaluator deliberately does NOT do:
 *   - Database filtering. The caller supplies the candidate set.
 *   - Cancellation policy resolution (Slice B6).
 *   - Search-response formatting. Wraps as `{ available, reason? }`.
 *   - Multi-season stitching. The caller passes a single seasonId.
 */

export type RestrictionKind =
  | 'STOP_SELL'
  | 'CTA'
  | 'CTD'
  | 'MIN_LOS'
  | 'MAX_LOS'
  | 'ADVANCE_PURCHASE_MIN'
  | 'ADVANCE_PURCHASE_MAX'
  | 'RELEASE_HOURS'
  | 'CUTOFF_HOURS';

export interface RestrictionSnapshot {
  readonly id: string;
  readonly contractId: string | null;
  readonly seasonId: string | null;
  readonly ratePlanId: string | null;
  readonly roomTypeId: string | null;
  /** ISO YYYY-MM-DD. */
  readonly stayDate: string;
  readonly restrictionKind: RestrictionKind;
  readonly params: Readonly<Record<string, unknown>>;
  /** ISO 8601 timestamp. */
  readonly effectiveFrom: string;
  /** ISO 8601 timestamp; null = open-ended. */
  readonly effectiveTo: string | null;
  /** Set when this row has been replaced by a newer one. */
  readonly supersededById: string | null;
}

export interface EvaluateRestrictionsInput {
  readonly stay: {
    /** ISO YYYY-MM-DD, inclusive. */
    readonly checkIn: string;
    /** ISO YYYY-MM-DD, exclusive. */
    readonly checkOut: string;
  };
  /** Caller's request-time clock. The evaluator never reads `Date.now()`. */
  readonly now: Date;
  /** Direct-contract id this offer was assembled from; null for supplier-default scopes. */
  readonly contractId?: string | null;
  /** Season covering the stay; null when the offer is supplier-default or stay spans no season. */
  readonly seasonId?: string | null;
  readonly ratePlanId?: string | null;
  readonly roomTypeId?: string | null;
  readonly restrictions: ReadonlyArray<RestrictionSnapshot>;
}

export interface RestrictionFailureReason {
  readonly kind: RestrictionKind;
  readonly ruleId: string;
  readonly contractId: string | null;
  readonly seasonId: string | null;
  /** Stay date that triggered the failure (null only for kinds that do not key on a single date). */
  readonly stayDate: string | null;
  /** For LOS / advance-purchase / cutoff failures: the rule's required threshold. */
  readonly required?: number;
  /** For LOS / advance-purchase / cutoff failures: the observed value (nights, days, hours). */
  readonly observed?: number;
}

export type RestrictionEvaluationResult =
  | { readonly available: true }
  | { readonly available: false; readonly reason: RestrictionFailureReason };

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function evaluateRestrictions(
  input: EvaluateRestrictionsInput,
): RestrictionEvaluationResult {
  validateStayInput(input.stay);

  const candidates = input.restrictions.filter((r) => isCandidate(r, input));
  const checkInDate = parseIsoDate(input.stay.checkIn);
  const nights = nightsCount(input.stay.checkIn, input.stay.checkOut);

  // STOP_SELL — every stay night must clear; iterate in chronological order.
  for (const night of iterateNights(input.stay.checkIn, input.stay.checkOut)) {
    const winner = pickWinner(candidates, 'STOP_SELL', night);
    if (winner) return fail('STOP_SELL', winner, night);
  }

  // CTA on the actual check-in date.
  const cta = pickWinner(candidates, 'CTA', input.stay.checkIn);
  if (cta) return fail('CTA', cta, input.stay.checkIn);

  // CTD locked to the actual checkout date per the user's instruction.
  const ctd = pickWinner(candidates, 'CTD', input.stay.checkOut);
  if (ctd) return fail('CTD', ctd, input.stay.checkOut);

  const minLos = pickWinner(candidates, 'MIN_LOS', input.stay.checkIn);
  if (minLos) {
    const required = readInt(minLos.params, 'min_los');
    if (required !== undefined && nights < required) {
      return fail('MIN_LOS', minLos, input.stay.checkIn, { required, observed: nights });
    }
  }

  const maxLos = pickWinner(candidates, 'MAX_LOS', input.stay.checkIn);
  if (maxLos) {
    const required = readInt(maxLos.params, 'max_los');
    if (required !== undefined && nights > required) {
      return fail('MAX_LOS', maxLos, input.stay.checkIn, { required, observed: nights });
    }
  }

  const daysUntilCheckIn = Math.floor(
    (checkInDate.getTime() - input.now.getTime()) / 86_400_000,
  );

  const apMin = pickWinner(candidates, 'ADVANCE_PURCHASE_MIN', input.stay.checkIn);
  if (apMin) {
    const required = readInt(apMin.params, 'days');
    if (required !== undefined && daysUntilCheckIn < required) {
      return fail('ADVANCE_PURCHASE_MIN', apMin, input.stay.checkIn, {
        required,
        observed: daysUntilCheckIn,
      });
    }
  }

  const apMax = pickWinner(candidates, 'ADVANCE_PURCHASE_MAX', input.stay.checkIn);
  if (apMax) {
    const required = readInt(apMax.params, 'days');
    // Only fires when booking is too FAR in advance. Negative
    // days-until-checkIn (booking past the stay) is left to the
    // cutoff family, not advance-purchase MAX.
    if (required !== undefined && daysUntilCheckIn > required) {
      return fail('ADVANCE_PURCHASE_MAX', apMax, input.stay.checkIn, {
        required,
        observed: daysUntilCheckIn,
      });
    }
  }

  const hoursUntilCheckIn = Math.floor(
    (checkInDate.getTime() - input.now.getTime()) / 3_600_000,
  );

  const release = pickWinner(candidates, 'RELEASE_HOURS', input.stay.checkIn);
  if (release) {
    const required = readInt(release.params, 'hours');
    if (required !== undefined && hoursUntilCheckIn < required) {
      return fail('RELEASE_HOURS', release, input.stay.checkIn, {
        required,
        observed: hoursUntilCheckIn,
      });
    }
  }

  const cutoff = pickWinner(candidates, 'CUTOFF_HOURS', input.stay.checkIn);
  if (cutoff) {
    const required = readInt(cutoff.params, 'hours');
    if (required !== undefined && hoursUntilCheckIn < required) {
      return fail('CUTOFF_HOURS', cutoff, input.stay.checkIn, {
        required,
        observed: hoursUntilCheckIn,
      });
    }
  }

  return { available: true };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function isCandidate(
  r: RestrictionSnapshot,
  ctx: EvaluateRestrictionsInput,
): boolean {
  if (r.supersededById !== null) return false;

  const nowMs = ctx.now.getTime();
  const fromMs = Date.parse(r.effectiveFrom);
  if (Number.isNaN(fromMs) || fromMs > nowMs) return false;
  if (r.effectiveTo !== null) {
    const toMs = Date.parse(r.effectiveTo);
    if (Number.isNaN(toMs) || toMs < nowMs) return false;
  }

  const requestContract = ctx.contractId ?? null;
  const requestSeason = ctx.seasonId ?? null;
  const requestRatePlan = ctx.ratePlanId ?? null;
  const requestRoomType = ctx.roomTypeId ?? null;

  // Scope: contract — supplier-default rows (contract NULL) match any
  // request; contract-scoped rows must match the request's contract.
  if (r.contractId !== null && r.contractId !== requestContract) return false;
  // Scope: season — same NULL-matches-anything semantic.
  if (r.seasonId !== null && r.seasonId !== requestSeason) return false;
  // Filters: rate plan / room type narrow but never reorder tiers.
  if (r.ratePlanId !== null && r.ratePlanId !== requestRatePlan) return false;
  if (r.roomTypeId !== null && r.roomTypeId !== requestRoomType) return false;

  return true;
}

function pickWinner(
  candidates: ReadonlyArray<RestrictionSnapshot>,
  kind: RestrictionKind,
  stayDate: string,
): RestrictionSnapshot | undefined {
  const matched = candidates.filter(
    (r) => r.restrictionKind === kind && r.stayDate === stayDate,
  );
  if (matched.length === 0) return undefined;
  return pickMostSpecific(matched);
}

/**
 * ADR-023 D4 most-specific-wins: contract+season > contract-only >
 * supplier-default. Only the highest tier with at least one
 * candidate is consulted; rows from lower tiers never combine with
 * higher-tier rows for the same `(kind, stay_date)`.
 *
 * Within a tier, ties are broken by the lower `id`.
 */
function pickMostSpecific(
  matched: ReadonlyArray<RestrictionSnapshot>,
): RestrictionSnapshot | undefined {
  const tier1 = matched.filter((r) => r.contractId !== null && r.seasonId !== null);
  if (tier1.length > 0) return lowestId(tier1);
  const tier2 = matched.filter((r) => r.contractId !== null && r.seasonId === null);
  if (tier2.length > 0) return lowestId(tier2);
  const tier3 = matched.filter((r) => r.contractId === null);
  if (tier3.length > 0) return lowestId(tier3);
  return undefined;
}

function lowestId(
  arr: ReadonlyArray<RestrictionSnapshot>,
): RestrictionSnapshot {
  let winner = arr[0]!;
  for (let i = 1; i < arr.length; i++) {
    const candidate = arr[i]!;
    if (candidate.id < winner.id) winner = candidate;
  }
  return winner;
}

function fail(
  kind: RestrictionKind,
  rule: RestrictionSnapshot,
  stayDate: string | null,
  metrics: { required?: number; observed?: number } = {},
): RestrictionEvaluationResult {
  return {
    available: false,
    reason: {
      kind,
      ruleId: rule.id,
      contractId: rule.contractId,
      seasonId: rule.seasonId,
      stayDate,
      ...(metrics.required !== undefined ? { required: metrics.required } : {}),
      ...(metrics.observed !== undefined ? { observed: metrics.observed } : {}),
    },
  };
}

function readInt(
  params: Readonly<Record<string, unknown>>,
  key: string,
): number | undefined {
  const v = params[key];
  return typeof v === 'number' && Number.isInteger(v) ? v : undefined;
}

function validateStayInput(stay: { checkIn: string; checkOut: string }): void {
  if (!ISO_DATE_RE.test(stay.checkIn)) {
    throw new Error(`RestrictionEvaluator: stay.checkIn "${stay.checkIn}" is not ISO YYYY-MM-DD`);
  }
  if (!ISO_DATE_RE.test(stay.checkOut)) {
    throw new Error(`RestrictionEvaluator: stay.checkOut "${stay.checkOut}" is not ISO YYYY-MM-DD`);
  }
  const ci = parseIsoDate(stay.checkIn);
  const co = parseIsoDate(stay.checkOut);
  if (co.getTime() <= ci.getTime()) {
    throw new Error(
      `RestrictionEvaluator: stay.checkOut (${stay.checkOut}) must be strictly after stay.checkIn (${stay.checkIn})`,
    );
  }
}

function parseIsoDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}

function* iterateNights(checkIn: string, checkOut: string): Iterable<string> {
  const start = parseIsoDate(checkIn);
  const end = parseIsoDate(checkOut);
  const total = Math.round((end.getTime() - start.getTime()) / 86_400_000);
  for (let i = 0; i < total; i++) {
    const d = new Date(start.getTime());
    d.setUTCDate(d.getUTCDate() + i);
    yield d.toISOString().slice(0, 10);
  }
}

function nightsCount(checkIn: string, checkOut: string): number {
  const start = parseIsoDate(checkIn);
  const end = parseIsoDate(checkOut);
  return Math.round((end.getTime() - start.getTime()) / 86_400_000);
}
