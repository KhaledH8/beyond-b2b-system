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
 * ADR-003 + ADR-013 (ingestionMode) + ADR-020 (money-movement axes).
 */
export interface StaticAdapterMeta {
  readonly supplierId: string;
  readonly displayName: string;
  readonly ingestionMode: IngestionMode;
  readonly supportedCollectionModes: ReadonlyArray<CollectionMode>;
  readonly supportedSettlementModes: ReadonlyArray<SupplierSettlementMode>;
  readonly supportedPaymentCostModels: ReadonlyArray<PaymentCostModel>;
  readonly capabilities: ReadonlyArray<AdapterCapability>;
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
 * Carries the full ADR-020 three-axis money-movement triple so that
 * downstream code never branches on supplierId.
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
  readonly commissionParams?: CommissionParams;
  readonly cancellationPolicy: CancellationPolicy;
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
