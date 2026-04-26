import type {
  AccountContext,
  AppliedMarkup,
  GrossCurrencySemantics,
  MarkupRuleScope,
  MarkupRuleSnapshot,
  Money,
  MoneyMovementTriple,
  PriceQuote,
  PricingTrace,
  PricingTraceStep,
} from '@bb/domain';
import {
  applyPercentMarkup,
  fromMinorUnits,
  toMinorUnits,
} from './money';

/**
 * Pure pricing evaluator for SOURCED_COMPOSED offers (ADR-021).
 *
 * Inputs are an in-memory `PriceableSourcedOffer`, the rules
 * applicable to the request (loaded by the search service from
 * `pricing_markup_rule`), and the account context. No DB, no IO —
 * the evaluator is a function of its arguments so it can be unit
 * tested and audited without a stack.
 *
 * Precedence (CLAUDE.md §5):
 *   1. ACCOUNT — a rule whose `accountId` matches `ctx.accountId`.
 *   2. HOTEL   — a rule whose `supplierHotelId` matches the offer.
 *   3. CHANNEL — a rule whose `accountType` matches `ctx.accountType`.
 *
 * Within a single scope, the rule with the highest `priority` wins;
 * `id` breaks final ties for determinism. If no rule fires, the
 * selling price equals the net cost and the trace records why.
 *
 * What this evaluator deliberately does NOT do (yet):
 *   - Currency conversion. The selling price is always in the same
 *     currency as the net cost. Cross-currency pricing is a separate
 *     concern (ADR-004 step 1) and lands when the FX module exists.
 *   - Tax / fee composition. ADR-004 step 3 — separate evaluator step.
 *   - Promotions / discounts. ADR-004 step 4 — applied AFTER markup.
 *   - Fixed or market-adjusted markup kinds. Only PERCENT in this
 *     slice. The rule-loader filters out unknown kinds; adding a kind
 *     is additive.
 */

export interface PriceableSourcedOffer {
  readonly supplierHotelId: string;
  readonly netAmountMinorUnits: bigint;
  readonly currency: string;
  /** ADR-004 / ADR-020: when present, a COLLECTION_AND_SETTLEMENT_BIND step is appended to the trace immediately after NET_COST. */
  readonly moneyMovement?: MoneyMovementTriple;
  readonly grossCurrencySemantics?: GrossCurrencySemantics;
}

export interface EvaluatedOffer {
  readonly priceQuote: PriceQuote;
  readonly trace: PricingTrace;
}

export function evaluateSourcedOffer(
  offer: PriceableSourcedOffer,
  rules: ReadonlyArray<MarkupRuleSnapshot>,
  ctx: AccountContext,
): EvaluatedOffer {
  const winning = pickRule(rules, ctx, offer.supplierHotelId);

  const netMoney: Money = {
    amount: fromMinorUnits(offer.netAmountMinorUnits, offer.currency),
    currency: offer.currency,
  };
  const steps: PricingTraceStep[] = [
    {
      kind: 'NET_COST',
      before: netMoney,
      after: netMoney,
      reason: 'supplier net (sourced composed total)',
    },
  ];

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

  if (!winning) {
    return {
      priceQuote: { netCost: netMoney, sellingPrice: netMoney },
      trace: { steps, finalSellAmount: netMoney },
    };
  }

  const markupMinor = applyPercentMarkup(
    offer.netAmountMinorUnits,
    winning.percentValue,
  );
  const sellingMinor = offer.netAmountMinorUnits + markupMinor;
  const sellingMoney: Money = {
    amount: fromMinorUnits(sellingMinor, offer.currency),
    currency: offer.currency,
  };
  const markupMoney: Money = {
    amount: fromMinorUnits(markupMinor, offer.currency),
    currency: offer.currency,
  };

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
    priceQuote: {
      netCost: netMoney,
      sellingPrice: sellingMoney,
      appliedMarkup,
    },
    trace: { steps, finalSellAmount: sellingMoney },
  };
}

// ---------------------------------------------------------------------------
// Rule precedence resolution (exported for unit tests + debug tooling)
// ---------------------------------------------------------------------------

const SCOPE_PRECEDENCE: Record<MarkupRuleScope, number> = {
  ACCOUNT: 3,
  HOTEL: 2,
  CHANNEL: 1,
};

export function pickRule(
  rules: ReadonlyArray<MarkupRuleSnapshot>,
  ctx: AccountContext,
  supplierHotelId: string,
): MarkupRuleSnapshot | undefined {
  const matching = rules.filter((r) => matches(r, ctx, supplierHotelId));
  if (matching.length === 0) return undefined;

  // Sort: scope precedence DESC, priority DESC, id ASC (stable tie-break).
  const sorted = [...matching].sort((a, b) => {
    const scopeDiff = SCOPE_PRECEDENCE[b.scope] - SCOPE_PRECEDENCE[a.scope];
    if (scopeDiff !== 0) return scopeDiff;
    if (a.priority !== b.priority) return b.priority - a.priority;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return sorted[0];
}

function matches(
  rule: MarkupRuleSnapshot,
  ctx: AccountContext,
  supplierHotelId: string,
): boolean {
  if (rule.tenantId !== ctx.tenantId) return false;
  if (rule.markupKind !== 'PERCENT') return false; // unknown kinds skipped
  switch (rule.scope) {
    case 'ACCOUNT':
      return rule.accountId === ctx.accountId;
    case 'HOTEL':
      return rule.supplierHotelId === supplierHotelId;
    case 'CHANNEL':
      return rule.accountType === ctx.accountType;
  }
}

export {
  toMinorUnits as _toMinorUnitsForTesting,
  fromMinorUnits as _fromMinorUnitsForTesting,
};
