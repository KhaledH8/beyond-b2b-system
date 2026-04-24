import type {
  HotelbedsAvailabilityResponse,
  HotelbedsHotelsResponse,
} from '@bb/adapter-hotelbeds';
import hotelsPage01 from './fixtures/hotels-page-01.json';
import availability01 from './fixtures/availability-01.json';
import type { HotelbedsFixtures } from './fixture-client';

export { createFixtureHotelbedsClient } from './fixture-client';
export type { HotelbedsFixtures } from './fixture-client';

/**
 * Canonical fixture set used by the conformance suite. One content
 * page (two hotels) + one availability response (one hotel, one room,
 * two rates — NRF and FLEX). Import and pass to
 * `createFixtureHotelbedsClient` for deterministic replay.
 */
export const HOTELBEDS_FIXTURES: HotelbedsFixtures = {
  hotelsResponse: hotelsPage01 as HotelbedsHotelsResponse,
  availabilityResponse: availability01 as HotelbedsAvailabilityResponse,
};
