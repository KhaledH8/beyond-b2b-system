/**
 * ADR-020: Three-axis money-movement model.
 * Every SupplierRate and every Booking carries all three.
 * Downstream code branches on these axes, never on supplier identity.
 */

/** Who collects guest payment. */
export type CollectionMode =
  | 'BB_COLLECTS'
  | 'RESELLER_COLLECTS'
  | 'PROPERTY_COLLECT'
  | 'UPSTREAM_PLATFORM_COLLECT';

/** How Beyond Borders settles with the supplier. */
export type SupplierSettlementMode =
  | 'PREPAID_BALANCE'
  | 'POSTPAID_INVOICE'
  | 'COMMISSION_ONLY'
  | 'VCC_TO_PROPERTY'
  | 'DIRECT_PROPERTY_CHARGE';

/** Who bears payment acquiring cost. */
export type PaymentCostModel =
  | 'PLATFORM_CARD_FEE'
  | 'RESELLER_CARD_FEE'
  | 'PROPERTY_CARD_FEE'
  | 'UPSTREAM_NETTED'
  | 'BANK_TRANSFER_SETTLEMENT';

export interface MoneyMovementTriple {
  readonly collectionMode: CollectionMode;
  readonly supplierSettlementMode: SupplierSettlementMode;
  readonly paymentCostModel: PaymentCostModel;
}

/** ADR-013: adapter ingestion mode. */
export type IngestionMode = 'PULL' | 'PUSH' | 'HYBRID';

/**
 * Semantics of the gross amount provided by the adapter.
 * ADR-020 extension to ADR-003.
 */
export type GrossCurrencySemantics =
  | 'NET_TO_BB'
  | 'GROSS_TO_GUEST'
  | 'COMMISSION_RATE';

/**
 * ADR-021 offer-vs-authored shape declaration.
 * Bedbank / OTA / affiliate APIs return composed offers we snapshot
 * (SOURCED_COMPOSED); direct / CRS / channel-manager sources author
 * primitives we compose (AUTHORED_PRIMITIVES). HYBRID_AUTHORED_OVERLAY
 * covers sources that return composed totals but also push a subset
 * of authored primitives (rare, e.g. contracted-override layers on
 * a bedbank-style feed).
 */
export type OfferShape =
  | 'SOURCED_COMPOSED'
  | 'AUTHORED_PRIMITIVES'
  | 'HYBRID_AUTHORED_OVERLAY';

/**
 * ADR-021 description of what a source COMMITTED to expose about a
 * rate's breakdown. Not a goal we try to infer — the adapter declares
 * the minimum it guarantees, and each `AdapterSupplierRate` may
 * declare equal or better granularity per-rate.
 *
 * Persisted on every sourced offer snapshot and on every booking-time
 * snapshot (ADR-021, CLAUDE.md §9 item 12).
 */
export type RateBreakdownGranularity =
  | 'TOTAL_ONLY'
  | 'PER_NIGHT_TOTAL'
  | 'PER_NIGHT_COMPONENTS'
  | 'PER_NIGHT_COMPONENTS_TAX'
  | 'AUTHORED_PRIMITIVES';
