import type {
  TenantContext,
  Occupancy,
} from '@bb/domain';
import type {
  HotelbedsMoneyMovementResolver,
  HotelbedsMoneyMovementResolution,
} from './money-movement';

/**
 * ADR-021: sourced snapshots cannot carry the AUTHORED_PRIMITIVES
 * granularity — that value belongs to the authored write path. The
 * DB CHECK constraint on `offer_sourced_snapshot.rate_breakdown_granularity`
 * rejects it; this type mirrors the constraint statically.
 */
type SourcedGranularity =
  | 'TOTAL_ONLY'
  | 'PER_NIGHT_TOTAL'
  | 'PER_NIGHT_COMPONENTS'
  | 'PER_NIGHT_COMPONENTS_TAX';
import type {
  AdapterSupplierRate,
  CancellationPolicy,
  RateRequest,
} from '@bb/supplier-contract';
import type {
  HotelbedsClient,
  HotelbedsAvailabilityRate,
  HotelbedsAvailabilityResponse,
} from './client';
import type {
  MappingPersistencePort,
  RawPayloadStoragePort,
  SourcedOfferPersistencePort,
  SourcedCancellationPolicyInput,
} from './ports';
import { HOTELBEDS_META, HOTELBEDS_SUPPLIER_ID } from './meta';

/**
 * Availability TTL for sourced snapshots. Hotelbeds rates are valid
 * for a short window after return; this floor pins `valid_until` on
 * `offer_sourced_snapshot` so the TTL sweeper can expire rows.
 * Set to 15 minutes per Hotelbeds' typical rateKey lifetime; real
 * lifetime comes from the response when present in Phase 2.
 */
const DEFAULT_RATEKEY_TTL_MS = 15 * 60 * 1000;

export interface SearchRunInput {
  readonly ctx: TenantContext;
  readonly searchSessionId: string;
  readonly request: RateRequest;
  /** Resolved via mapping lookup before the search runs. */
  readonly canonicalHotelId?: string;
  /** Override TTL when the response exposes a rateKey lifetime. */
  readonly rateKeyTtlMs?: number;
  /** ULID factory — injected so tests can make ids deterministic. */
  readonly newSnapshotId: () => string;
}

export interface SearchRunOutput {
  readonly rates: ReadonlyArray<AdapterSupplierRate>;
  readonly snapshotsWritten: number;
}

/**
 * End-to-end sourced search + persist flow for a single hotel.
 *
 * 1. Call Hotelbeds availability.
 * 2. Store the raw payload (ADR-003) — one ref shared across all
 *    rates in the response, since they came from a single request.
 * 3. For each returned rate:
 *    a. Write the `offer_sourced_snapshot` (+ cancellation policy).
 *       Components and restrictions are only written when Hotelbeds
 *       committed to expose them; ADR-021 forbids fabrication.
 *    b. Upsert observation rows in `hotel_*_mapping` with status
 *       PENDING — the mapping pipeline promotes them later.
 *    c. Project a flat `AdapterSupplierRate` for the contract caller.
 *
 * No write to `hotel_canonical` here: that is populated by content
 * sync + mapping and only linked into the snapshot when the mapping
 * pipeline has resolved `canonicalHotelId` (passed in via input).
 */
export async function runSourcedSearchAndPersist(
  deps: {
    readonly client: HotelbedsClient;
    readonly rawStorage: RawPayloadStoragePort;
    readonly offers: SourcedOfferPersistencePort;
    readonly mappings: MappingPersistencePort;
    readonly moneyMovementResolver: HotelbedsMoneyMovementResolver;
  },
  input: SearchRunInput,
): Promise<SearchRunOutput> {
  const { client, rawStorage, offers, mappings, moneyMovementResolver } = deps;
  const { ctx, searchSessionId, request, canonicalHotelId, newSnapshotId } = input;

  const response = await client.checkAvailability({
    checkIn: request.checkIn,
    checkOut: request.checkOut,
    occupancies: [
      {
        adults: request.occupancy.adults,
        children: request.occupancy.children,
        childAges: request.occupancy.childAges ?? [],
      },
    ],
    supplierHotelCodes: [request.supplierHotelId],
    ...(request.currency !== undefined ? { currency: request.currency } : {}),
  });

  const rawPayload = await rawStorage.put({
    tenantId: ctx.tenantId,
    supplierId: HOTELBEDS_SUPPLIER_ID,
    purpose: 'AVAILABILITY',
    contentType: response.contentType,
    bytes: response.rawBytes,
  });

  const ttlMs = input.rateKeyTtlMs ?? DEFAULT_RATEKEY_TTL_MS;
  const validUntil = new Date(Date.now() + ttlMs);

  const rates: AdapterSupplierRate[] = [];
  let snapshotsWritten = 0;

  for (const hotel of response.parsed.hotels) {
    for (const room of hotel.rooms) {
      for (const rate of room.rates) {
        const snapshotId = newSnapshotId();

        // --- write snapshot ---------------------------------------------
        await offers.recordSnapshot({
          snapshotId,
          tenantId: ctx.tenantId,
          searchSessionId,
          supplierHotelCode: hotel.code,
          ...(canonicalHotelId !== undefined ? { canonicalHotelId } : {}),
          supplierRateKey: rate.rateKey,
          checkIn: request.checkIn,
          checkOut: request.checkOut,
          occupancyAdults: request.occupancy.adults,
          occupancyChildrenAges: request.occupancy.childAges ?? [],
          supplierRoomCode: room.code,
          supplierRateCode: rate.rateClass,
          ...(rate.boardCode !== undefined ? { supplierMealCode: rate.boardCode } : {}),
          totalAmountMinorUnits: toMinorUnits(rate.net, hotel.currency),
          totalCurrency: hotel.currency,
          rateBreakdownGranularity: detectGranularity(rate),
          validUntil,
          rawPayload,
          components: [], // TOTAL_ONLY floor; do NOT fabricate breakdowns
          restrictions: [], // no reliable restriction disclosure from this API
          ...(rate.cancellationPolicies
            ? { cancellationPolicy: normalizeCancellationPolicy(rate, hotel.currency) }
            : {}),
        });

        // --- mapping observation rows -----------------------------------
        // PENDING rows let the mapping pipeline discover new codes
        // without the adapter guessing canonical ids.
        await Promise.all([
          mappings.upsertRoomMapping({
            supplierId: HOTELBEDS_SUPPLIER_ID,
            supplierHotelId: hotel.code,
            supplierRoomCode: room.code,
            rawSignals: { via: 'availability' },
          }),
          mappings.upsertRatePlanMapping({
            supplierId: HOTELBEDS_SUPPLIER_ID,
            supplierHotelId: hotel.code,
            supplierRateCode: rate.rateClass,
            rawSignals: { rateType: rate.rateType, via: 'availability' },
          }),
          rate.boardCode
            ? mappings.upsertMealPlanMapping({
                supplierId: HOTELBEDS_SUPPLIER_ID,
                supplierMealCode: rate.boardCode,
                rawSignals: { via: 'availability' },
              })
            : Promise.resolve(),
          mappings.upsertOccupancyMapping({
            supplierId: HOTELBEDS_SUPPLIER_ID,
            supplierHotelId: hotel.code,
            rawSignals: {
              adults: request.occupancy.adults,
              children: request.occupancy.children,
            },
          }),
        ]);

        snapshotsWritten += 1;

        // --- resolve money-movement for this rate (ADR-020 per-rate) ----
        // Hotelbeds availability does not reliably commit the triple,
        // so every rate runs through a Hotelbeds-specific resolver the
        // composition root injected. PROVISIONAL results carry a safe
        // fallback triple + a loud provenance flag so the booking saga
        // refuses the rate until ops has confirmed the contract model.
        const resolution = moneyMovementResolver.resolve({
          tenantId: ctx.tenantId,
          supplierHotelCode: hotel.code,
          rate,
          hotel,
        });

        // --- project flat AdapterSupplierRate for the contract caller ---
        rates.push(
          toAdapterSupplierRate({
            rate,
            hotelCurrency: hotel.currency,
            request,
            roomCode: room.code,
            occupancy: request.occupancy,
            moneyMovement: resolution,
          }),
        );
      }
    }
  }

  return { rates, snapshotsWritten };
}

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

function detectGranularity(_rate: HotelbedsAvailabilityRate): SourcedGranularity {
  // Adapter declares TOTAL_ONLY as its floor (meta.minRateBreakdownGranularity).
  // Phase 2 may inspect `_rate` for a nightly breakdown and upgrade to
  // PER_NIGHT_TOTAL when it is present; Phase 1 scaffold ships TOTAL_ONLY.
  return 'TOTAL_ONLY';
}

/**
 * Parse a decimal-string amount (e.g. Hotelbeds returns `"120.50"`) to
 * integer minor units for the given currency. Keeps financial math
 * exact — never converts via JS number.
 */
function toMinorUnits(amount: string, currency: string): bigint {
  const exponent = minorUnitExponent(currency);
  const [whole, fractionRaw = ''] = amount.split('.');
  const fraction = (fractionRaw + '0'.repeat(exponent)).slice(0, exponent);
  const wholePart = whole ?? '0';
  return BigInt(wholePart + fraction);
}

function minorUnitExponent(currency: string): number {
  // ISO 4217 zero-decimal currencies relevant to travel. Default to 2
  // rather than maintain a full table: incorrect assumptions on
  // JPY/KRW etc. are rare in the Hotelbeds supply we ship with
  // but must not silently land — Phase 2 replaces this with the
  // money module's authoritative table.
  const zeroDecimal = new Set(['JPY', 'KRW', 'VND', 'ISK']);
  return zeroDecimal.has(currency.toUpperCase()) ? 0 : 2;
}

function normalizeCancellationPolicy(
  rate: HotelbedsAvailabilityRate,
  currency: string,
): SourcedCancellationPolicyInput {
  const windows = (rate.cancellationPolicies ?? []).map((p) => {
    const from = new Date(p.from);
    const hoursBefore = Math.max(
      0,
      Math.round((from.getTime() - Date.now()) / 3_600_000),
    );
    return {
      fromHoursBefore: hoursBefore,
      toHoursBefore: 0,
      feeType: 'FIXED' as const,
      feeAmount: p.amount,
      feeCurrency: currency,
      feeBasis: 'PER_STAY' as const,
    };
  });

  const refundable = windows.length > 0
    ? windows.every((w) => w.fromHoursBefore > 0)
    : false;

  return {
    refundable,
    windows,
    parsedWith: 'hotelbeds-adapter@0.0.0',
  };
}

function toAdapterCancellationPolicy(
  rate: HotelbedsAvailabilityRate,
  currency: string,
): CancellationPolicy {
  const penalties = (rate.cancellationPolicies ?? []).map((p) => ({
    from: new Date(p.from),
    amount: {
      amount: p.amount,
      currency,
    },
  }));

  if (penalties.length === 0) {
    return { isFreeCancellable: false, penalties: [] };
  }

  const firstPenalty = penalties[0]!;
  return {
    isFreeCancellable: firstPenalty.from.getTime() > Date.now(),
    freeCancellationDeadline: firstPenalty.from,
    penalties,
  };
}

function toAdapterSupplierRate(args: {
  readonly rate: HotelbedsAvailabilityRate;
  readonly hotelCurrency: string;
  readonly request: RateRequest;
  readonly roomCode: string;
  readonly occupancy: Occupancy;
  readonly moneyMovement: HotelbedsMoneyMovementResolution;
}): AdapterSupplierRate {
  const { rate, hotelCurrency, request, roomCode, occupancy, moneyMovement } = args;
  const moneyMovementTriple =
    moneyMovement.status === 'RESOLVED'
      ? moneyMovement.triple
      : moneyMovement.fallbackTriple;
  const moneyMovementProvenance =
    moneyMovement.status === 'RESOLVED' ? moneyMovement.source : 'PROVISIONAL';

  return {
    supplierId: HOTELBEDS_SUPPLIER_ID,
    supplierHotelId: request.supplierHotelId,
    supplierRateId: rate.rateKey,
    roomType: roomCode,
    ratePlan: rate.rateClass,
    checkIn: request.checkIn,
    checkOut: request.checkOut,
    occupancy,
    grossAmount: { amount: rate.net, currency: hotelCurrency },
    grossCurrencySemantics: 'NET_TO_BB',
    moneyMovement: moneyMovementTriple,
    moneyMovementProvenance,
    cancellationPolicy: toAdapterCancellationPolicy(rate, hotelCurrency),
    offerShape: HOTELBEDS_META.offerShape,
    rateBreakdownGranularity: detectGranularity(rate),
    supplierRawRef: rate.rateKey,
  };
}

export function _testonly_toMinorUnits(amount: string, currency: string): bigint {
  return toMinorUnits(amount, currency);
}

export type { HotelbedsAvailabilityResponse };
