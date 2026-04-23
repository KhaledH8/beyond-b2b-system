import type { StaticAdapterMeta } from '@bb/supplier-contract';

/**
 * Hotelbeds is a bedbank. It returns composed offers (rateKeys with a
 * total) and does not expose structured per-component breakdowns
 * reliably across properties. ADR-021 shape contract:
 *   - offerShape = SOURCED_COMPOSED
 *   - minRateBreakdownGranularity = TOTAL_ONLY
 *
 * Individual rates MAY declare PER_NIGHT_TOTAL or better when the
 * Hotelbeds response includes a nightly breakdown for that property,
 * but the adapter commits only to TOTAL_ONLY across the portfolio.
 *
 * Money-movement (ADR-020): Hotelbeds is a prepaid-balance bedbank.
 * We collect the guest (`BB_COLLECTS`) and settle to the supplier
 * from our deposit (`PREPAID_BALANCE`); platform bears card fees
 * (`PLATFORM_CARD_FEE`). Other triples may become supported later
 * behind commercial agreements; listed here is what Phase 2 ships.
 */
export const HOTELBEDS_SUPPLIER_ID = 'hotelbeds';

export const HOTELBEDS_META: StaticAdapterMeta = {
  supplierId: HOTELBEDS_SUPPLIER_ID,
  displayName: 'Hotelbeds',
  ingestionMode: 'PULL',
  supportedCollectionModes: ['BB_COLLECTS'],
  supportedSettlementModes: ['PREPAID_BALANCE'],
  supportedPaymentCostModels: ['PLATFORM_CARD_FEE'],
  capabilities: [
    'STATIC_CONTENT',
    'DYNAMIC_RATES',
    'BOOKING',
    'CANCELLATION',
    'INSTANT_CONFIRMATION',
  ],
  offerShape: 'SOURCED_COMPOSED',
  minRateBreakdownGranularity: 'TOTAL_ONLY',
};
