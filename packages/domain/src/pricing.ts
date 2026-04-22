import type { Money } from './shared';

export type MarkupRuleType =
  | 'PERCENT_MARKUP'
  | 'FIXED_MARKUP_ABSOLUTE'
  | 'MARKET_ADJUSTED_MARKUP';

export type PricingTraceStepKind =
  | 'NET_COST'
  | 'CURRENCY_CONVERSION'
  | 'MARKUP_APPLIED'
  | 'TAX_AND_FEES'
  | 'PROMOTION_APPLIED'
  | 'COLLECTION_AND_SETTLEMENT_BIND';

export interface PricingTraceStep {
  readonly kind: PricingTraceStepKind;
  readonly before: Money;
  readonly after: Money;
  readonly ruleId?: string;
  readonly reason?: string;
}

export interface PricingTrace {
  readonly steps: PricingTraceStep[];
  readonly finalSellAmount: Money;
  /**
   * ADR-014 / ADR-020: margin after source cost, mode-aware card fee,
   * and any supplier post-booking rebates. Owned by pricing; consumed
   * by rewards as a narrow read-only value.
   */
  readonly recognizedMargin?: Money;
}

export interface MarkupRule {
  readonly id: string;
  readonly tenantId: string;
  readonly ruleType: MarkupRuleType;
  readonly accountId?: string;
  readonly accountType?: string;
  readonly supplierId?: string;
  readonly destinationCountryCode?: string;
  readonly percentMarkup?: string;
  readonly fixedMarkupAmount?: Money;
  readonly priority: number;
  readonly isActive: boolean;
}

export interface PricedOffer {
  readonly canonicalHotelId: string;
  readonly supplierId: string;
  readonly supplierRateId: string;
  readonly sellAmount: Money;
  readonly sourceCost: Money;
  readonly trace: PricingTrace;
}
