import type { TenantContext } from '@bb/domain';
import type { AdapterHotel } from '@bb/supplier-contract';

/**
 * Persistence ports for the Hotelbeds adapter.
 *
 * The adapter package depends only on `@bb/domain` and
 * `@bb/supplier-contract` per ADR-011. Concrete DB implementations
 * live in the composition root (`apps/api` / `apps/worker`). These
 * ports describe the writes the adapter orchestrator needs to make;
 * they deliberately mirror row shapes of the tables listed in the
 * Phase 1 scaffold scope (ADR-021).
 *
 * Each write is expected to be idempotent on its natural key:
 *   - hotel_supplier: (supplier_id, supplier_hotel_code)
 *   - hotel_*_mapping: partial unique idx excluding REJECTED|SUPERSEDED
 *   - offer_sourced_snapshot: (supplier_id, supplier_rate_key, search_session_id)
 *
 * When a piece of Hotelbeds data is not reliably exposed — a
 * component breakdown, a structured restriction — the port MUST NOT
 * be called with fabricated values. ADR-021 invariant: never
 * fabricate authored primitives from a sourced total.
 */

// -------------------------------------------------------------------------
// Supplier row (one-time bootstrap)
// -------------------------------------------------------------------------

export interface SupplierRegistrationPort {
  /**
   * Idempotently upsert the `supply_supplier` row for Hotelbeds. Called
   * once at adapter startup or on migration; not on every search.
   */
  upsertSupplier(row: {
    readonly supplierId: string;
    readonly displayName: string;
    readonly ingestionMode: 'PULL' | 'PUSH' | 'HYBRID';
  }): Promise<void>;
}

// -------------------------------------------------------------------------
// Raw payload object storage (ADR-003 / ADR-021: raw is kept)
// -------------------------------------------------------------------------

export interface RawPayloadRef {
  /** Lowercase hex sha256 of the raw bytes. 64 chars. */
  readonly hash: string;
  /** Object-storage key, e.g. `hotelbeds/2026/04/23/<hash>.json`. */
  readonly storageRef: string;
}

export interface RawPayloadStoragePort {
  /**
   * Store the raw adapter response as-received. Implementation hashes
   * the bytes with sha256 and uploads to the configured bucket. The
   * hash doubles as the content-addressable filename to make
   * deduplication cheap and reconciliation trivial.
   */
  put(params: {
    readonly tenantId: string;
    readonly supplierId: string;
    readonly purpose: 'HOTELS_PAGE' | 'AVAILABILITY';
    readonly contentType: string;
    readonly bytes: Uint8Array;
  }): Promise<RawPayloadRef>;
}

// -------------------------------------------------------------------------
// Hotel content persistence (hotel_supplier)
// -------------------------------------------------------------------------

export interface HotelContentPersistencePort {
  /**
   * Idempotently upsert `hotel_supplier` rows for a page of Hotelbeds
   * hotels. `raw_content` receives the per-hotel portion of the raw
   * payload (so individual hotels remain inspectable); the full-page
   * raw payload ref is passed separately for auditability.
   */
  upsertSupplierHotels(ctx: TenantContext, params: {
    readonly hotels: ReadonlyArray<AdapterHotel>;
    readonly rawPayload: RawPayloadRef;
  }): Promise<void>;
}

// -------------------------------------------------------------------------
// Dimension mapping persistence (hotel_*_mapping)
// -------------------------------------------------------------------------

/**
 * All mapping rows enter as `status = PENDING, mapping_method =
 * DETERMINISTIC` at adapter-write time. The mapping pipeline
 * (Phase 1 `packages/mapping/`) promotes them to CONFIRMED, or a
 * human-review worker flips them to MANUAL. The adapter only records
 * "this supplier code was observed against this supplier hotel"; it
 * does NOT invent canonical ids.
 */
export interface MappingPersistencePort {
  upsertRoomMapping(params: {
    readonly supplierId: string;
    readonly supplierHotelId: string;
    readonly supplierRoomCode: string;
    readonly rawSignals: Record<string, unknown>;
  }): Promise<void>;

  upsertRatePlanMapping(params: {
    readonly supplierId: string;
    readonly supplierHotelId: string;
    readonly supplierRateCode: string;
    readonly rawSignals: Record<string, unknown>;
  }): Promise<void>;

  upsertMealPlanMapping(params: {
    readonly supplierId: string;
    readonly supplierMealCode: string;
    readonly rawSignals: Record<string, unknown>;
  }): Promise<void>;

  upsertOccupancyMapping(params: {
    readonly supplierId: string;
    readonly supplierHotelId: string;
    readonly supplierOccupancyCode?: string;
    readonly rawSignals: Record<string, unknown>;
  }): Promise<void>;
}

// -------------------------------------------------------------------------
// Sourced offer snapshot persistence (offer_sourced_*)
// -------------------------------------------------------------------------

/**
 * A single composed offer as returned by Hotelbeds. Maps 1:1 to an
 * `offer_sourced_snapshot` row plus 0..N `offer_sourced_component` /
 * `offer_sourced_restriction` rows and at most one
 * `offer_sourced_cancellation_policy` row.
 *
 * Hotelbeds declares `TOTAL_ONLY` at the adapter level. When per-rate
 * the API DOES expose a nightly or component breakdown, the adapter
 * MAY upgrade `rateBreakdownGranularity` on that row and emit
 * `components`. Not inventing components when the API did not commit
 * to expose them is an ADR-021 invariant.
 */
export interface SourcedOfferSnapshotInput {
  readonly snapshotId: string;
  readonly tenantId: string;
  readonly searchSessionId: string;

  readonly supplierHotelCode: string;
  readonly canonicalHotelId?: string;

  readonly supplierRateKey: string;
  readonly checkIn: string;
  readonly checkOut: string;
  readonly occupancyAdults: number;
  readonly occupancyChildrenAges: ReadonlyArray<number>;

  readonly supplierRoomCode: string;
  readonly supplierRateCode: string;
  readonly supplierMealCode?: string;

  readonly totalAmountMinorUnits: bigint;
  readonly totalCurrency: string;
  readonly rateBreakdownGranularity:
    | 'TOTAL_ONLY'
    | 'PER_NIGHT_TOTAL'
    | 'PER_NIGHT_COMPONENTS'
    | 'PER_NIGHT_COMPONENTS_TAX';

  readonly validUntil: Date;
  readonly rawPayload: RawPayloadRef;

  readonly components: ReadonlyArray<SourcedComponentInput>;
  readonly restrictions: ReadonlyArray<SourcedRestrictionInput>;
  readonly cancellationPolicy?: SourcedCancellationPolicyInput;
}

export interface SourcedComponentInput {
  readonly componentKind:
    | 'ROOM_RATE'
    | 'MEAL_SUPPLEMENT'
    | 'EXTRA_PERSON_CHARGE'
    | 'TAX'
    | 'FEE'
    | 'DISCOUNT'
    | 'OTHER';
  readonly description?: string;
  readonly amountMinorUnits: bigint;
  readonly currency: string;
  readonly appliesToNightDate?: string;
  readonly appliesToPersonKind?: 'ADULT' | 'EXTRA_ADULT' | 'CHILD' | 'INFANT';
  readonly inclusive: boolean;
}

export interface SourcedRestrictionInput {
  readonly restrictionKind:
    | 'STOP_SELL'
    | 'CTA'
    | 'CTD'
    | 'MIN_LOS'
    | 'MAX_LOS'
    | 'ADVANCE_PURCHASE_MIN'
    | 'ADVANCE_PURCHASE_MAX'
    | 'RELEASE_HOURS'
    | 'CUTOFF_HOURS';
  readonly params: Record<string, unknown>;
  readonly sourceVerbatimText?: string;
}

export interface SourcedCancellationPolicyInput {
  readonly refundable: boolean;
  readonly windows: ReadonlyArray<{
    readonly fromHoursBefore: number;
    readonly toHoursBefore: number;
    readonly feeType: 'PERCENT' | 'FIXED' | 'FIRST_NIGHT' | 'FULL_STAY';
    readonly feeAmount?: string;
    readonly feeCurrency?: string;
    readonly feeBasis?: 'PER_STAY' | 'PER_NIGHT';
  }>;
  readonly sourceVerbatimText?: string;
  /** Parser id + version; re-parses of historical snapshots must not overwrite this. */
  readonly parsedWith?: string;
}

export interface SourcedOfferPersistencePort {
  /**
   * Write one snapshot + its children in a single transaction.
   * Components, restrictions, and cancellation policy are only written
   * when the input arrays are non-empty / cancellationPolicy is
   * defined. The adapter MUST NOT fabricate missing data.
   */
  recordSnapshot(input: SourcedOfferSnapshotInput): Promise<void>;
}
