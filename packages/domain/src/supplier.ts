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
