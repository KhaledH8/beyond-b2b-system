import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  HotelbedsAvailabilityResponse,
  HotelbedsHotelsResponse,
} from '@bb/adapter-hotelbeds';

/**
 * Hotelbeds-only environment binding.
 *
 * The generic `@bb/config` covers cross-cutting infra (Postgres, Redis,
 * MinIO, port). Adapter-specific knobs (signing keys, base URL, retry
 * tuning, capture dir, fixture dir, client kind) live next to the
 * adapter wiring instead of widening the generic config — adding a
 * supplier should not require editing `@bb/config`.
 *
 * `kind` selects the runtime client. Default is `'stub'` so a fresh
 * checkout boots without credentials and surfaces a loud
 * `HotelbedsNotImplementedError` on the first call. Set
 * `HOTELBEDS_CLIENT_KIND=live` (with credentials) for staging/prod
 * and `=fixture` for local replay.
 */
export type HotelbedsClientKind = 'stub' | 'fixture' | 'live';

export interface HotelbedsConfig {
  readonly kind: HotelbedsClientKind;
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly baseUrl: string;
  readonly requestTimeoutMs: number;
  readonly maxRetries: number;
  readonly retryBaseDelayMs: number;
  /** When set, every successful live response is also persisted to disk. */
  readonly captureDir?: string;
  /** Directory holding fixture JSON files; required when kind === 'fixture'. */
  readonly fixtureDir?: string;
}

export function loadHotelbedsConfig(): HotelbedsConfig {
  const kind = parseKind(process.env['HOTELBEDS_CLIENT_KIND']);
  const cfg: HotelbedsConfig = {
    kind,
    apiKey: process.env['HOTELBEDS_API_KEY'] ?? '',
    apiSecret: process.env['HOTELBEDS_API_SECRET'] ?? '',
    baseUrl:
      process.env['HOTELBEDS_BASE_URL'] ?? 'https://api.test.hotelbeds.com',
    requestTimeoutMs: parsePositiveInt(
      process.env['HOTELBEDS_REQUEST_TIMEOUT_MS'],
      15_000,
    ),
    maxRetries: parseNonNegativeInt(process.env['HOTELBEDS_MAX_RETRIES'], 3),
    retryBaseDelayMs: parsePositiveInt(
      process.env['HOTELBEDS_RETRY_BASE_DELAY_MS'],
      200,
    ),
    ...(process.env['HOTELBEDS_CAPTURE_DIR']
      ? { captureDir: process.env['HOTELBEDS_CAPTURE_DIR'] }
      : {}),
    ...(process.env['HOTELBEDS_FIXTURE_DIR']
      ? { fixtureDir: process.env['HOTELBEDS_FIXTURE_DIR'] }
      : {}),
  };
  validate(cfg);
  return cfg;
}

function parseKind(raw: string | undefined): HotelbedsClientKind {
  const v = (raw ?? 'stub').toLowerCase();
  if (v === 'stub' || v === 'fixture' || v === 'live') return v;
  throw new Error(
    `Invalid HOTELBEDS_CLIENT_KIND="${raw}". Expected stub | fixture | live.`,
  );
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid Hotelbeds env value "${raw}": expected positive integer`);
  }
  return n;
}

function parseNonNegativeInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Invalid Hotelbeds env value "${raw}": expected non-negative integer`);
  }
  return n;
}

function validate(cfg: HotelbedsConfig): void {
  if (cfg.kind === 'live') {
    if (!cfg.apiKey || !cfg.apiSecret) {
      throw new Error(
        'HOTELBEDS_CLIENT_KIND=live requires HOTELBEDS_API_KEY and HOTELBEDS_API_SECRET',
      );
    }
  }
  if (cfg.kind === 'fixture' && !cfg.fixtureDir) {
    throw new Error(
      'HOTELBEDS_CLIENT_KIND=fixture requires HOTELBEDS_FIXTURE_DIR pointing at hotels-page-01.json + availability-01.json',
    );
  }
}

/**
 * Read the two fixture JSON files from `fixtureDir`. Used by the
 * composition root when `kind === 'fixture'`. Synchronous on purpose:
 * runs once at module init, before any request is served.
 */
export function readFixtureFiles(fixtureDir: string): {
  hotelsResponse: HotelbedsHotelsResponse;
  availabilityResponse: HotelbedsAvailabilityResponse;
} {
  const hotelsPath = path.join(fixtureDir, 'hotels-page-01.json');
  const availPath = path.join(fixtureDir, 'availability-01.json');
  return {
    hotelsResponse: JSON.parse(
      fs.readFileSync(hotelsPath, 'utf-8'),
    ) as HotelbedsHotelsResponse,
    availabilityResponse: JSON.parse(
      fs.readFileSync(availPath, 'utf-8'),
    ) as HotelbedsAvailabilityResponse,
  };
}
