/**
 * The canonical fixture client now lives in `@bb/adapter-hotelbeds` so
 * the composition root can select it via `HOTELBEDS_CLIENT_KIND=fixture`
 * without taking a runtime dependency on the testing package. This
 * file re-exports the factory and its types so existing imports of
 * `@bb/testing` keep resolving — no behavioural change.
 */
export {
  createFixtureHotelbedsClient,
} from '@bb/adapter-hotelbeds';
export type { HotelbedsFixtures } from '@bb/adapter-hotelbeds';
