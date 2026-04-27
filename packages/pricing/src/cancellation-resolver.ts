/**
 * Pure cancellation policy resolver (ADR-023 Phase B Slice B6).
 *
 * Inputs are an in-memory list of `CancellationPolicySnapshot` rows
 * already loaded from `rate_auth_cancellation_policy` by the search
 * assembly layer, plus the request's `(contractId, ratePlanId)`
 * scope and an explicit `now`. Output is either the resolved policy
 * or a clear "no policy applies" answer. No DB, no IO, no
 * `Date.now()`.
 *
 * Precedence (most-specific-wins, mirroring restrictions D4):
 *   tier 1 — contract_id NOT NULL AND rate_plan_id NOT NULL
 *   tier 2 — contract_id NOT NULL AND rate_plan_id NULL
 *   tier 3 — contract_id NULL     AND rate_plan_id NOT NULL
 *   tier 4 — contract_id NULL     AND rate_plan_id NULL
 *
 * Within a tier, the highest `policy_version` wins (ADR-023 D5);
 * ties on version are broken by the lower `id`.
 *
 * Filters applied before the tier scan:
 *   - `superseded_by_id IS NULL` (admins signal "this row is dead"
 *     by setting the link; the resolver respects that even when the
 *     superseded row's effective window still covers `now`)
 *   - `effective_from <= now` AND (`effective_to` IS NULL OR `effective_to >= now`)
 *   - scope match: a non-null `contractId` / `ratePlanId` on the
 *     row must equal the request's value; `null` matches any value.
 *
 * The resolver does NOT compute fees, render windows, or perform
 * any booking-time snapshotting. Booking-time snapshot pinning
 * (CLAUDE.md §11 item 11) is a separate concern that lives in the
 * booking saga and is deferred past Phase B.
 */

export interface CancellationPolicySnapshot {
  readonly id: string;
  readonly contractId: string | null;
  readonly ratePlanId: string | null;
  readonly policyVersion: number;
  readonly windowsJsonb: ReadonlyArray<unknown>;
  readonly refundable: boolean;
  /** ISO 8601 timestamp. */
  readonly effectiveFrom: string;
  /** ISO 8601 timestamp; null = open-ended. */
  readonly effectiveTo: string | null;
  readonly supersededById: string | null;
}

export interface ResolveCancellationPolicyInput {
  readonly now: Date;
  readonly contractId?: string | null;
  readonly ratePlanId?: string | null;
  readonly policies: ReadonlyArray<CancellationPolicySnapshot>;
}

export type CancellationPolicyResolution =
  | { readonly resolved: true; readonly policy: CancellationPolicySnapshot }
  | { readonly resolved: false };

export function resolveCancellationPolicy(
  input: ResolveCancellationPolicyInput,
): CancellationPolicyResolution {
  const ctxContract = input.contractId ?? null;
  const ctxRatePlan = input.ratePlanId ?? null;
  const nowMs = input.now.getTime();

  const active = input.policies.filter((p) => {
    if (p.supersededById !== null) return false;
    const fromMs = Date.parse(p.effectiveFrom);
    if (Number.isNaN(fromMs) || fromMs > nowMs) return false;
    if (p.effectiveTo !== null) {
      const toMs = Date.parse(p.effectiveTo);
      if (Number.isNaN(toMs) || toMs < nowMs) return false;
    }
    if (p.contractId !== null && p.contractId !== ctxContract) return false;
    if (p.ratePlanId !== null && p.ratePlanId !== ctxRatePlan) return false;
    return true;
  });
  if (active.length === 0) return { resolved: false };

  const tier1 = active.filter(
    (p) => p.contractId !== null && p.ratePlanId !== null,
  );
  if (tier1.length > 0) return { resolved: true, policy: pickHighest(tier1) };

  const tier2 = active.filter(
    (p) => p.contractId !== null && p.ratePlanId === null,
  );
  if (tier2.length > 0) return { resolved: true, policy: pickHighest(tier2) };

  const tier3 = active.filter(
    (p) => p.contractId === null && p.ratePlanId !== null,
  );
  if (tier3.length > 0) return { resolved: true, policy: pickHighest(tier3) };

  const tier4 = active.filter(
    (p) => p.contractId === null && p.ratePlanId === null,
  );
  if (tier4.length > 0) return { resolved: true, policy: pickHighest(tier4) };

  return { resolved: false };
}

function pickHighest(
  arr: ReadonlyArray<CancellationPolicySnapshot>,
): CancellationPolicySnapshot {
  let winner = arr[0]!;
  for (let i = 1; i < arr.length; i++) {
    const c = arr[i]!;
    if (c.policyVersion > winner.policyVersion) {
      winner = c;
    } else if (c.policyVersion === winner.policyVersion && c.id < winner.id) {
      winner = c;
    }
  }
  return winner;
}
