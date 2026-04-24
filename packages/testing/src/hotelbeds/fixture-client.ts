import type {
  HotelbedsAvailabilityRequest,
  HotelbedsAvailabilityResponse,
  HotelbedsClient,
  HotelbedsHotelsRequest,
  HotelbedsHotelsResponse,
  HotelbedsRawResponse,
} from '@bb/adapter-hotelbeds';

/**
 * Fixture-replay Hotelbeds client.
 *
 * Implements `HotelbedsClient` by returning pre-captured responses
 * from local JSON fixtures. Real HTTP is explicitly out of scope in
 * this phase — this client lets the adapter orchestrators run
 * end-to-end against the live Postgres + MinIO stack without ever
 * touching the internet.
 *
 * The raw bytes returned to the adapter are the UTF-8 JSON encoding
 * of the fixture body, so:
 *   - `raw_payload_hash` (sha256) is deterministic for a given fixture
 *   - object-storage keys are stable, enabling byte-for-byte replay
 *   - reconciliation against fixtures is as simple as reading the same
 *     bytes back from MinIO
 *
 * Each response ignores the inbound request shape — fixture replay is
 * a "whatever you ask, here is what was recorded" contract. Tests
 * that need to vary the response should feed a different fixture.
 */
export interface HotelbedsFixtures {
  readonly hotelsResponse: HotelbedsHotelsResponse;
  readonly availabilityResponse: HotelbedsAvailabilityResponse;
}

export function createFixtureHotelbedsClient(
  fixtures: HotelbedsFixtures,
): HotelbedsClient {
  return {
    async listHotels(
      _req: HotelbedsHotelsRequest,
    ): Promise<HotelbedsRawResponse<HotelbedsHotelsResponse>> {
      return toRawResponse(fixtures.hotelsResponse);
    },
    async checkAvailability(
      _req: HotelbedsAvailabilityRequest,
    ): Promise<HotelbedsRawResponse<HotelbedsAvailabilityResponse>> {
      return toRawResponse(fixtures.availabilityResponse);
    },
  };
}

function toRawResponse<T>(parsed: T): HotelbedsRawResponse<T> {
  const json = JSON.stringify(parsed);
  return {
    parsed,
    rawBytes: new TextEncoder().encode(json),
    contentType: 'application/json',
  };
}
