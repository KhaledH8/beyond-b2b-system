import type {
  TenantContext,
  PaginationCursor,
  Money,
  Occupancy,
  MoneyMovementTriple,
  CollectionMode,
  SupplierSettlementMode,
  PaymentCostModel,
  IngestionMode,
  GrossCurrencySemantics,
  OfferShape,
  RateBreakdownGranularity,
} from '@bb/domain';

export type AdapterCapability =
  | 'STATIC_CONTENT'
  | 'DYNAMIC_RATES'
  | 'BOOKING'
  | 'CANCELLATION'
  | 'INSTANT_CONFIRMATION'
  | 'ON_REQUEST'
  | 'ARI_PUSH';

/**
 * Declares what a supplier adapter supports at the static metadata level.
 * ADR-003 + ADR-013 (ingestionMode) + ADR-020 (money-movement axes)
 *          + ADR-021 (offerShape, minRateBreakdownGranularity).
 */
export interface StaticAdapterMeta {
  readonly supplierId: string;
  readonly displayName: string;
  readonly ingestionMode: IngestionMode;
  readonly supportedCollectionModes: ReadonlyArray<CollectionMode>;
  readonly supportedSettlementModes: ReadonlyArray<SupplierSettlementMode>;
  readonly supportedPaymentCostModels: ReadonlyArray<PaymentCostModel>;
  readonly capabilities: ReadonlyArray<AdapterCapability>;
  /**
   * ADR-021: declares whether the source returns composed offers we
   * snapshot (SOURCED_COMPOSED) or authors primitives we compose
   * (AUTHORED_PRIMITIVES). Immutable per adapter version — a source
   * that changes shape gets a new adapter.
   */
  readonly offerShape: OfferShape;
  /**
   * ADR-021: the floor of what the adapter guarantees to expose about
   * a rate's breakdown. Downstream code that wants richer data must
   * degrade gracefully when only the minimum is available. Individual
   * rates may declare equal-or-better granularity; they must never
   * declare worse.
   */
  readonly minRateBreakdownGranularity: RateBreakdownGranularity;
}

export interface AdapterHotelAddress {
  readonly line1: string;
  readonly city: string;
  readonly countryCode: string;
  readonly postalCode?: string;
}

export interface AdapterHotel {
  readonly supplierHotelId: string;
  readonly name: string;
  readonly address: AdapterHotelAddress;
  readonly lat?: number;
  readonly lng?: number;
  readonly starRating?: number;
  readonly chainCode?: string;
}

export interface AdapterHotelPage {
  readonly hotels: ReadonlyArray<AdapterHotel>;
  readonly nextCursor?: string;
}

export interface RateRequest {
  readonly supplierHotelId: string;
  readonly checkIn: string;
  readonly checkOut: string;
  readonly occupancy: Occupancy;
  readonly currency?: string;
}

export interface CancellationPenalty {
  readonly from: Date;
  readonly amount: Money;
}

export interface CancellationPolicy {
  readonly isFreeCancellable: boolean;
  readonly freeCancellationDeadline?: Date;
  readonly penalties: ReadonlyArray<CancellationPenalty>;
}

export interface CommissionParams {
  readonly rate: string;
  readonly basis: 'NET' | 'GROSS';
}

/**
 * A rate returned by the adapter.
 * Carries the full ADR-020 three-axis money-movement triple and the
 * ADR-021 shape declaration so that downstream code never branches on
 * supplierId.
 */
export interface AdapterSupplierRate {
  readonly supplierId: string;
  readonly supplierHotelId: string;
  readonly supplierRateId: string;
  readonly roomType: string;
  readonly ratePlan: string;
  readonly checkIn: string;
  readonly checkOut: string;
  readonly occupancy: Occupancy;
  readonly grossAmount: Money;
  readonly grossCurrencySemantics: GrossCurrencySemantics;
  readonly moneyMovement: MoneyMovementTriple;
  /**
   * ADR-020 addendum: declares how the adapter arrived at the
   * `moneyMovement` triple on this rate. Optional for backwards
   * compatibility; absent is treated as `CONFIG_RESOLVED` by existing
   * callers that never branched on it. Values:
   *   - `PAYLOAD_DERIVED`  — the supplier response itself committed the
   *     collection/settlement/payment-cost model for this rate.
   *   - `CONFIG_RESOLVED`  — the adapter resolved the triple from a
   *     known commercial agreement held in config, not from the payload.
   *   - `PROVISIONAL`      — neither the payload nor config determined
   *     the triple; the rate carries a safe fallback that downstream
   *     booking code MUST refuse to act on until resolved.
   */
  readonly moneyMovementProvenance?:
    | 'PAYLOAD_DERIVED'
    | 'CONFIG_RESOLVED'
    | 'PROVISIONAL';
  readonly commissionParams?: CommissionParams;
  readonly cancellationPolicy: CancellationPolicy;
  /**
   * ADR-021: shape of this rate. SOURCED_COMPOSED adapters return
   * only a composed total (optionally with partial breakdowns);
   * AUTHORED_PRIMITIVES adapters return composition ingredients that
   * pricing re-evaluates. Must match or be a subset of the adapter's
   * declared `meta.offerShape`.
   */
  readonly offerShape: OfferShape;
  /**
   * ADR-021: granularity this specific rate exposes. Must be equal to
   * or richer than `meta.minRateBreakdownGranularity`. Persisted on
   * `offer_sourced_snapshot.rate_breakdown_granularity` for sourced
   * shape, or derived from authored primitives for the authored shape.
   */
  readonly rateBreakdownGranularity: RateBreakdownGranularity;
  /** Opaque string preserved for idempotent booking calls. */
  readonly supplierRawRef: string;
}

export interface BookRequest {
  readonly supplierHotelId: string;
  readonly supplierRateId: string;
  readonly supplierRawRef: string;
  readonly checkIn: string;
  readonly checkOut: string;
  readonly occupancy: Occupancy;
  readonly guestFirstName: string;
  readonly guestLastName: string;
  readonly guestEmail: string;
  readonly idempotencyKey: string;
}

export interface BookConfirmation {
  readonly supplierBookingRef: string;
  readonly status: 'CONFIRMED' | 'ON_REQUEST';
  readonly confirmedAt?: Date;
}

export interface CancelRequest {
  readonly supplierBookingRef: string;
  readonly idempotencyKey: string;
}

export interface CancelConfirmation {
  readonly status: 'CANCELLED';
  readonly cancelledAt: Date;
  readonly refundAmount?: Money;
}

/**
 * Every supply source implements this interface.
 * Aggregators, direct paper contracts, CRS, and channel managers all
 * satisfy the same contract. ADR-003 + amendments ADR-013, ADR-020.
 */
export interface SupplierAdapter {
  readonly meta: StaticAdapterMeta;
  fetchHotels(ctx: TenantContext, page: PaginationCursor): Promise<AdapterHotelPage>;
  fetchRates(ctx: TenantContext, req: RateRequest): Promise<ReadonlyArray<AdapterSupplierRate>>;
  book(ctx: TenantContext, req: BookRequest): Promise<BookConfirmation>;
  cancel(ctx: TenantContext, req: CancelRequest): Promise<CancelConfirmation>;
}
