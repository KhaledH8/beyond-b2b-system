import { HotelbedsNotImplementedError } from './errors';

/**
 * HTTP client skeleton for the Hotelbeds APIs.
 *
 * Hotelbeds exposes two relevant surfaces: the Content API (static
 * hotel content, cached with short TTLs per supplier terms) and the
 * Booking/Activity API (dynamic availability, rate caching, booking,
 * cancellation). This skeleton declares the shape of each call so
 * the orchestrators in `content-sync.ts` / `search.ts` can be
 * compiled and typechecked; the actual HTTP wiring lands in Phase 2
 * once credentials and the signing/apiKey flow are confirmed.
 *
 * The client surface is deliberately narrow — one method per logical
 * operation the adapter orchestrator needs. Pagination cursors,
 * signing, retries, and rate-limit back-pressure are an
 * implementation concern of each concrete method, not an exposed API.
 */
export interface HotelbedsClientConfig {
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly baseUrl: string;
  /** Soft request timeout in ms; surfaces as a typed error on exceed. */
  readonly requestTimeoutMs: number;
}

/**
 * Raw response envelope: the caller receives both the parsed JSON and
 * the raw bytes so the orchestrator can persist the payload to object
 * storage unchanged (ADR-003: raw is kept).
 */
export interface HotelbedsRawResponse<TParsed> {
  readonly parsed: TParsed;
  readonly rawBytes: Uint8Array;
  readonly contentType: string;
}

export interface HotelbedsHotelsRequest {
  readonly cursor?: string;
  readonly pageSize: number;
  readonly language?: string;
}

export interface HotelbedsHotelsResponse {
  readonly hotels: ReadonlyArray<HotelbedsHotelRaw>;
  readonly nextCursor?: string;
}

export interface HotelbedsHotelRaw {
  readonly code: string;
  readonly name: string;
  readonly countryCode: string;
  readonly address: { readonly content: string; readonly postalCode?: string };
  readonly city: { readonly content: string };
  readonly coordinates?: { readonly latitude: number; readonly longitude: number };
  readonly categoryCode?: string;
  readonly chainCode?: string;
}

export interface HotelbedsAvailabilityRequest {
  readonly checkIn: string;
  readonly checkOut: string;
  readonly occupancies: ReadonlyArray<{
    readonly adults: number;
    readonly children: number;
    readonly childAges: ReadonlyArray<number>;
  }>;
  readonly supplierHotelCodes: ReadonlyArray<string>;
  readonly currency?: string;
  readonly language?: string;
}

export interface HotelbedsAvailabilityResponse {
  readonly hotels: ReadonlyArray<HotelbedsAvailabilityHotel>;
}

export interface HotelbedsAvailabilityHotel {
  readonly code: string;
  readonly currency: string;
  readonly rooms: ReadonlyArray<HotelbedsAvailabilityRoom>;
}

export interface HotelbedsAvailabilityRoom {
  readonly code: string;
  readonly rates: ReadonlyArray<HotelbedsAvailabilityRate>;
}

/**
 * Hotelbeds returns `net` as the cost to the agency and optionally
 * a structured `cancellationPolicies` array. Component breakdowns
 * (taxes, extras) appear only when the property has opted in; ADR-021
 * forbids fabricating them when the API did not commit to expose.
 */
export interface HotelbedsAvailabilityRate {
  readonly rateKey: string;
  readonly rateClass: string;
  readonly rateType: string;
  readonly net: string;
  readonly boardCode?: string;
  readonly cancellationPolicies?: ReadonlyArray<{
    readonly amount: string;
    readonly from: string;
  }>;
  readonly taxes?: {
    readonly taxes?: ReadonlyArray<{
      readonly included: boolean;
      readonly amount: string;
      readonly currency: string;
    }>;
  };
}

export interface HotelbedsClient {
  listHotels(
    req: HotelbedsHotelsRequest,
  ): Promise<HotelbedsRawResponse<HotelbedsHotelsResponse>>;

  checkAvailability(
    req: HotelbedsAvailabilityRequest,
  ): Promise<HotelbedsRawResponse<HotelbedsAvailabilityResponse>>;
}

/**
 * Phase 1 scaffold client: every method throws
 * HotelbedsNotImplementedError. The orchestrators are written against
 * the interface above so injecting a real implementation in Phase 2
 * is a composition-root swap.
 */
export function createStubHotelbedsClient(_config: HotelbedsClientConfig): HotelbedsClient {
  return {
    listHotels() {
      return Promise.reject(new HotelbedsNotImplementedError('listHotels'));
    },
    checkAvailability() {
      return Promise.reject(new HotelbedsNotImplementedError('checkAvailability'));
    },
  };
}
