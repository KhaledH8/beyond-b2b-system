/**
 * DI tokens for the Hotelbeds composition root.
 *
 * Lives in its own file so adapter-internal services (controllers,
 * runner services) can `@Inject` these without importing the module
 * file (which itself imports the services — the cycle would either
 * fail or surface as runtime undefined).
 */
export const HOTELBEDS_ADAPTER = 'HOTELBEDS_ADAPTER' as const;

/**
 * Token for the runtime-selected `HotelbedsClient` (`stub | fixture |
 * live`). Lets services other than the adapter — e.g. the content-
 * sync runner — share the same client instance the adapter was built
 * with, so the `HOTELBEDS_CLIENT_KIND` switch lives in exactly one
 * place (`pickClient` inside `HotelbedsModule`).
 */
export const HOTELBEDS_CLIENT = 'HOTELBEDS_CLIENT' as const;

/**
 * Token for the resolved `HotelbedsConfig` singleton. Parsed once at
 * module init from env vars — request handlers must not call
 * `loadHotelbedsConfig()` themselves or they re-parse env on every
 * request. Inject this token when you only need a config field (e.g.
 * `config.kind` for response shaping in the controller).
 */
export const HOTELBEDS_CONFIG = 'HOTELBEDS_CONFIG' as const;
