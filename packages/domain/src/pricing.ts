import type { CurrencyCode, Money } from './shared';
import type { AccountType } from './account';

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
  | 'COLLECTION_AND_SETTLEMENT_BIND'
  | 'AUTHORED_BASE_RATE'
  | 'AUTHORED_OCCUPANCY_SUPPLEMENT'
  | 'AUTHORED_MEAL_SUPPLEMENT';

export interface PricingTraceStep {
  readonly kind: PricingTraceStepKind;
  readonly before: Money;
  readonly after: Money;
  readonly ruleId?: string;
  readonly reason?: string;
  /**
   * Populated only when kind === 'COLLECTION_AND_SETTLEMENT_BIND'
   * (ADR-004 / ADR-020). Records the resolved money-movement triple
   * and gross-currency semantics so every downstream decision sees
   * the same values that were bound at pricing time.
   * String union literals are inlined here rather than imported from
   * `@bb/domain/supplier` to keep the pricing trace type self-contained.
   */
  readonly collectionMode?: string;
  readonly supplierSettlementMode?: string;
  readonly paymentCostModel?: string;
  readonly grossCurrencySemantics?: string;
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

// ---------------------------------------------------------------------------
// Search + first-slice pricing (ADR-004 / ADR-021)
// ---------------------------------------------------------------------------

/**
 * Three precedence scopes a markup rule binds to. Higher in this list
 * wins regardless of `priority`. Exactly one of `accountId` /
 * `supplierHotelId` / `accountType` is set on a rule, matching its
 * scope. The DB enforces this with a CHECK constraint on
 * `pricing_markup_rule.scope`.
 */
export type MarkupRuleScope = 'ACCOUNT' | 'HOTEL' | 'CHANNEL';

/**
 * Operational shape of a markup rule as the evaluator sees it. Loaded
 * from `pricing_markup_rule` rows by the search service. Distinct
 * from `MarkupRule` above (which is a forward-looking declarative
 * shape used by upcoming rule-authoring tooling) so changes here
 * don't ripple into authoring concerns.
 */
export interface MarkupRuleSnapshot {
  readonly id: string;
  readonly tenantId: string;
  readonly scope: MarkupRuleScope;
  readonly accountId?: string;
  readonly supplierHotelId?: string;
  readonly accountType?: AccountType;
  readonly markupKind: 'PERCENT';
  /** Decimal string, e.g. "10.0000" — never a float. */
  readonly percentValue: string;
  readonly priority: number;
}

/**
 * Account context for pricing + merchandising. Carries the four
 * commercial channels (B2C / AGENCY / SUBSCRIBER / CORPORATE) plus
 * the specific account so account-level overrides can fire.
 */
export interface AccountContext {
  readonly tenantId: string;
  readonly accountId: string;
  readonly accountType: AccountType;
}

/**
 * What the pricing evaluator decided for one rate. The trace lives
 * separately on `PricingTrace`; this is the headline numbers a
 * downstream UI / API surface renders.
 */
export interface PriceQuote {
  readonly netCost: Money;
  readonly sellingPrice: Money;
  readonly appliedMarkup?: AppliedMarkup;
}

export interface AppliedMarkup {
  readonly ruleId: string;
  readonly scope: MarkupRuleScope;
  readonly markupKind: 'PERCENT';
  readonly percentValue: string;
  readonly markupAmount: Money;
}

// ---------------------------------------------------------------------------
// Search response contract (channel-aware, sourced-only for now)
// ---------------------------------------------------------------------------

export interface SearchOccupancy {
  readonly adults: number;
  readonly children: number;
  readonly childAges?: ReadonlyArray<number>;
}

export interface SearchRequest {
  readonly tenantId: string;
  readonly accountId: string;
  readonly supplierHotelIds: ReadonlyArray<string>;
  readonly checkIn: string;
  readonly checkOut: string;
  readonly occupancy: SearchOccupancy;
  readonly currency?: CurrencyCode;
}

export type PromotionKind = 'PROMOTED' | 'RECOMMENDED' | 'FEATURED';

export interface PromotionTag {
  readonly kind: PromotionKind;
  readonly priority: number;
}

export interface SearchResultRate {
  readonly supplierRateId: string;
  readonly roomType: string;
  readonly ratePlan: string;
  readonly priceQuote: PriceQuote;
  readonly trace: PricingTrace;
  readonly moneyMovementProvenance:
    | 'PAYLOAD_DERIVED'
    | 'CONFIG_RESOLVED'
    | 'PROVISIONAL';
  readonly isBookable: boolean;
  readonly bookingRefusalReason?: string;
  readonly offerShape: string;
  readonly rateBreakdownGranularity: string;
  /** Opaque value the booking saga will pass back to the supplier. */
  readonly supplierRawRef: string;
}

export interface SearchResultHotel {
  readonly supplierId: string;
  readonly supplierHotelCode: string;
  /**
   * Canonical hotel id (ADR-002, ADR-008) the result resolves to, when
   * known. Optional because some supplier results have not yet been
   * mapped to a canonical hotel — those degrade to undefined rather
   * than fabricate a value. Consumers use this to correlate results
   * for the same real-world property across different suppliers
   * (e.g. an aggregator-sourced result and a direct-contract-authored
   * result for the same hotel).
   */
  readonly canonicalHotelId?: string;
  readonly rates: ReadonlyArray<SearchResultRate>;
  readonly promotion?: PromotionTag;
}

export interface SearchResponseMeta {
  readonly searchId: string;
  readonly generatedAt: string;
  readonly accountContext: AccountContext;
  readonly currency: CurrencyCode;
  readonly resultCount: number;
}

export interface SearchResponse {
  readonly meta: SearchResponseMeta;
  readonly results: ReadonlyArray<SearchResultHotel>;
}
