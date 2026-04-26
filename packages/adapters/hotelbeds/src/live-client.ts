import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type {
  HotelbedsAvailabilityHotel,
  HotelbedsAvailabilityRequest,
  HotelbedsAvailabilityResponse,
  HotelbedsClient,
  HotelbedsClientConfig,
  HotelbedsHotelRaw,
  HotelbedsHotelsRequest,
  HotelbedsHotelsResponse,
  HotelbedsRawResponse,
} from './client';
import { HotelbedsAdapterError } from './errors';

/**
 * Phase 2 live HTTP client for the Hotelbeds Booking + Content APIs.
 *
 * Auth (per developer.hotelbeds.com `/getting-started`):
 *   - `Api-key: <apiKey>`
 *   - `X-Signature: SHA256_hex(apiKey + sharedSecret + unixTimestampSeconds)`
 *
 * Both headers are recomputed per request: Hotelbeds keys the
 * signature on a fresh timestamp and rejects stale ones.
 *
 * Endpoints (default `baseUrl = https://api.test.hotelbeds.com`):
 *   - Content listing  : GET  /hotel-content-api/1.0/hotels
 *   - Availability     : POST /hotel-api/1.0/hotels
 *
 * Response shape normalization (live → adapter contract):
 *   - Content `name` field is sometimes `{content}` and sometimes a
 *     plain string depending on `fields=all`; we accept either.
 *   - Availability response wraps the hotel array under
 *     `response.hotels.hotels`; we unwrap to match
 *     `HotelbedsAvailabilityResponse.hotels`.
 *
 * Retry policy:
 *   - Retries on 429 / 500 / 502 / 503 / 504, on timeouts (AbortError),
 *     and on transient network errors (TypeError from fetch).
 *   - Honors `Retry-After` (seconds or HTTP-date) when present.
 *   - Exponential backoff with jitter: `baseDelay * 2^attempt + rand`.
 *   - Default `maxRetries = 3`; configurable.
 *
 * Capture:
 *   - When `captureDir` is set, the raw response body for every
 *     successful call is written to disk as
 *     `<captureDir>/<purpose>/<isoTimestamp>-<sha256>.json`. Each file
 *     can be promoted into the regression-fixture suite verbatim.
 *   - Capture failures never break the request — they log to stderr
 *     and continue. The live client is the source of truth; capture
 *     is an observability side-effect.
 *
 * What this client does NOT do (deliberately, per Phase 2 scope):
 *   - Booking confirmation / cancellation calls (out of scope).
 *   - Pre-flight credential validation (`/status`); the first real
 *     request surfaces auth errors loudly enough.
 *   - Per-tenant credential rotation (single static set per process).
 */
export interface LiveHotelbedsClientConfig extends HotelbedsClientConfig {
  /** Default 3. Set to 0 to disable retries entirely. */
  readonly maxRetries?: number;
  /** Default 200. First retry waits ~baseDelay; doubles each step. */
  readonly retryBaseDelayMs?: number;
  /**
   * If set, every successful response is written to
   * `<captureDir>/<purpose>/<iso>-<sha>.json`. Intended for harvesting
   * real responses into the regression-fixture suite.
   */
  readonly captureDir?: string;
}

export function createLiveHotelbedsClient(
  config: LiveHotelbedsClientConfig,
): HotelbedsClient {
  validateConfig(config);

  return {
    async listHotels(
      req: HotelbedsHotelsRequest,
    ): Promise<HotelbedsRawResponse<HotelbedsHotelsResponse>> {
      const from = req.cursor ? Number.parseInt(req.cursor, 10) : 1;
      const to = from + req.pageSize - 1;
      const language = req.language ?? 'ENG';
      const url = new URL(`${normalizeBase(config.baseUrl)}/hotel-content-api/1.0/hotels`);
      url.searchParams.set('fields', 'all');
      url.searchParams.set('language', language);
      url.searchParams.set('from', String(from));
      url.searchParams.set('to', String(to));
      url.searchParams.set('useSecondaryLanguage', 'false');

      const { body, contentType } = await fetchWithRetry(
        url.toString(),
        { method: 'GET' },
        config,
      );
      const parsedRaw = parseJson<RawContentApiResponse>(body, 'content');
      const parsed = normalizeContentResponse(parsedRaw, to);

      await maybeCapture(config, 'hotels-page', body);
      return { parsed, rawBytes: body, contentType };
    },

    async checkAvailability(
      req: HotelbedsAvailabilityRequest,
    ): Promise<HotelbedsRawResponse<HotelbedsAvailabilityResponse>> {
      const url = `${normalizeBase(config.baseUrl)}/hotel-api/1.0/hotels`;
      const payload = {
        stay: { checkIn: req.checkIn, checkOut: req.checkOut },
        occupancies: req.occupancies.map((o) => ({
          rooms: 1,
          adults: o.adults,
          children: o.children,
          ...(o.childAges.length > 0
            ? { paxes: o.childAges.map((age) => ({ type: 'CH', age })) }
            : {}),
        })),
        hotels: { hotel: req.supplierHotelCodes.map((c) => Number(c)) },
        ...(req.currency !== undefined ? { currency: req.currency } : {}),
        ...(req.language !== undefined ? { language: req.language } : {}),
      };

      const { body, contentType } = await fetchWithRetry(
        url,
        {
          method: 'POST',
          body: JSON.stringify(payload),
          headers: { 'Content-Type': 'application/json' },
        },
        config,
      );
      const parsedRaw = parseJson<RawAvailabilityApiResponse>(body, 'availability');
      const parsed = normalizeAvailabilityResponse(parsedRaw);

      await maybeCapture(config, 'availability', body);
      return { parsed, rawBytes: body, contentType };
    },
  };
}

// -------------------------------------------------------------------------
// Auth signing (exported for unit tests; not exported from the package).
// -------------------------------------------------------------------------

/**
 * Compute the Hotelbeds `X-Signature` header. Public docs:
 *   sha256_hex(apiKey + sharedSecret + currentEpochSeconds)
 *
 * Exposed at module scope (not on the package public API) so the unit
 * test in this file can pin the algorithm against a known vector
 * without exporting auth internals to consumers.
 */
export function signHotelbedsRequest(
  apiKey: string,
  sharedSecret: string,
  nowSeconds: number,
): string {
  return createHash('sha256')
    .update(`${apiKey}${sharedSecret}${nowSeconds}`)
    .digest('hex');
}

// -------------------------------------------------------------------------
// HTTP transport: signed fetch + retry/backoff + timeout.
// -------------------------------------------------------------------------

interface InternalFetchInit {
  readonly method: 'GET' | 'POST';
  readonly body?: string;
  readonly headers?: Record<string, string>;
}

interface SignedResponse {
  readonly body: Uint8Array;
  readonly contentType: string;
}

async function fetchWithRetry(
  url: string,
  init: InternalFetchInit,
  config: LiveHotelbedsClientConfig,
): Promise<SignedResponse> {
  const maxRetries = config.maxRetries ?? 3;
  const baseDelay = config.retryBaseDelayMs ?? 200;

  let attempt = 0;
  for (;;) {
    try {
      return await signedFetchOnce(url, init, config);
    } catch (err) {
      if (attempt >= maxRetries || !isRetryable(err)) {
        throw err;
      }
      const retryAfter = retryAfterMs(err);
      const backoff =
        retryAfter ?? baseDelay * 2 ** attempt + Math.floor(Math.random() * baseDelay);
      await sleep(backoff);
      attempt += 1;
    }
  }
}

async function signedFetchOnce(
  url: string,
  init: InternalFetchInit,
  config: LiveHotelbedsClientConfig,
): Promise<SignedResponse> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const signature = signHotelbedsRequest(config.apiKey, config.apiSecret, nowSeconds);

  const headers: Record<string, string> = {
    'Api-key': config.apiKey,
    'X-Signature': signature,
    Accept: 'application/json',
    'Accept-Encoding': 'gzip',
    ...(init.headers ?? {}),
  };

  // AbortSignal.timeout (Node 17+) gives us a one-line request budget.
  // The thrown DOMException has name === 'TimeoutError' so retry logic
  // can distinguish timeouts from server-side 5xx.
  const signal = AbortSignal.timeout(config.requestTimeoutMs);

  const res = await fetch(url, {
    method: init.method,
    headers,
    ...(init.body !== undefined ? { body: init.body } : {}),
    signal,
  });

  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    throw new HotelbedsHttpError(res.status, res.headers, bodyText, url);
  }

  // Read full body. Hotelbeds responses are well under any reasonable
  // memory ceiling (single search returns kilobytes).
  const arrayBuffer = await res.arrayBuffer();
  const body = new Uint8Array(arrayBuffer);
  const contentType = res.headers.get('content-type') ?? 'application/json';
  return { body, contentType };
}

function isRetryable(err: unknown): boolean {
  if (err instanceof HotelbedsHttpError) {
    return err.status === 429 || (err.status >= 500 && err.status < 600);
  }
  if (err instanceof Error) {
    // AbortSignal.timeout throws DOMException('TimeoutError') on Node;
    // network failures from undici show up as TypeError. Both retry.
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return true;
    if (err.name === 'TypeError') return true;
  }
  return false;
}

function retryAfterMs(err: unknown): number | undefined {
  if (!(err instanceof HotelbedsHttpError)) return undefined;
  const header = err.headers.get('retry-after');
  if (!header) return undefined;
  // RFC 7231: integer seconds OR HTTP-date.
  const asInt = Number.parseInt(header, 10);
  if (Number.isFinite(asInt) && String(asInt) === header.trim()) {
    return asInt * 1000;
  }
  const asDate = Date.parse(header);
  if (Number.isFinite(asDate)) {
    return Math.max(0, asDate - Date.now());
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Typed HTTP error for non-2xx Hotelbeds responses. The retry layer
 * branches on `status`; downstream callers can inspect `bodyPreview`
 * for the error envelope without re-reading the response.
 */
export class HotelbedsHttpError extends HotelbedsAdapterError {
  constructor(
    readonly status: number,
    readonly headers: Headers,
    readonly bodyPreview: string,
    readonly requestedUrl: string,
  ) {
    super(
      `Hotelbeds ${status} from ${requestedUrl}: ${bodyPreview.slice(0, 200)}`,
      'HTTP_ERROR',
    );
    this.name = 'HotelbedsHttpError';
  }
}

// -------------------------------------------------------------------------
// Response normalization: live API shape → adapter contract shape.
// -------------------------------------------------------------------------

interface RawContentApiResponse {
  readonly hotels?: ReadonlyArray<RawContentHotel>;
  readonly total?: number;
  readonly to?: number;
}

interface RawContentHotel {
  readonly code: number | string;
  readonly name?: string | { readonly content?: string };
  readonly countryCode?: string;
  readonly address?:
    | string
    | { readonly content?: string; readonly postalCode?: string };
  readonly postalCode?: string;
  readonly city?: string | { readonly content?: string };
  readonly coordinates?: { readonly latitude?: number; readonly longitude?: number };
  readonly categoryCode?: string;
  readonly chainCode?: string;
}

function normalizeContentResponse(
  raw: RawContentApiResponse,
  pageEnd: number,
): HotelbedsHotelsResponse {
  const hotels: HotelbedsHotelRaw[] = (raw.hotels ?? []).map(
    (h): HotelbedsHotelRaw => {
      const name = pickContent(h.name) ?? '';
      const addressContent = pickContent(h.address) ?? '';
      const addressPostal =
        typeof h.address === 'object' && h.address !== null
          ? h.address.postalCode
          : h.postalCode;
      const cityContent = pickContent(h.city) ?? '';
      return {
        code: String(h.code),
        name,
        countryCode: h.countryCode ?? '',
        address: {
          content: addressContent,
          ...(addressPostal !== undefined ? { postalCode: addressPostal } : {}),
        },
        city: { content: cityContent },
        ...(h.coordinates &&
        typeof h.coordinates.latitude === 'number' &&
        typeof h.coordinates.longitude === 'number'
          ? {
              coordinates: {
                latitude: h.coordinates.latitude,
                longitude: h.coordinates.longitude,
              },
            }
          : {}),
        ...(h.categoryCode !== undefined ? { categoryCode: h.categoryCode } : {}),
        ...(h.chainCode !== undefined ? { chainCode: h.chainCode } : {}),
      };
    },
  );

  // Hotelbeds does not return a forward cursor — it returns running
  // (from, to, total). Synthesize a cursor as the next `from` index
  // when more rows exist; absent when we have walked off the end.
  const out: HotelbedsHotelsResponse = { hotels };
  if (raw.total !== undefined && raw.to !== undefined && raw.to < raw.total) {
    return { ...out, nextCursor: String(raw.to + 1) };
  }
  if (
    raw.total !== undefined &&
    raw.to === undefined &&
    pageEnd < raw.total
  ) {
    return { ...out, nextCursor: String(pageEnd + 1) };
  }
  return out;
}

function pickContent(
  v: undefined | string | { readonly content?: string },
): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v === 'string') return v;
  return v.content;
}

interface RawAvailabilityApiResponse {
  readonly hotels?: {
    readonly hotels?: ReadonlyArray<HotelbedsAvailabilityHotel & { readonly code: number | string }>;
  };
}

function normalizeAvailabilityResponse(
  raw: RawAvailabilityApiResponse,
): HotelbedsAvailabilityResponse {
  const inner = raw.hotels?.hotels ?? [];
  return {
    hotels: inner.map((h) => ({
      ...h,
      code: String(h.code),
    })),
  };
}

function parseJson<T>(bytes: Uint8Array, purpose: 'content' | 'availability'): T {
  const text = new TextDecoder('utf-8').decode(bytes);
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new HotelbedsAdapterError(
      `Hotelbeds ${purpose} response was not valid JSON: ${(err as Error).message}`,
      'INVALID_JSON',
    );
  }
}

// -------------------------------------------------------------------------
// Capture: best-effort write of the raw body for fixture promotion.
// -------------------------------------------------------------------------

async function maybeCapture(
  config: LiveHotelbedsClientConfig,
  purpose: 'hotels-page' | 'availability',
  body: Uint8Array,
): Promise<void> {
  if (!config.captureDir) return;
  try {
    const hash = createHash('sha256').update(body).digest('hex');
    const iso = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.join(config.captureDir, purpose);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${iso}-${hash}.json`);
    await writeFile(file, body);
  } catch (err) {
    // Capture is observability — never fail a real request because of it.
    console.warn(
      `[hotelbeds] capture write failed for ${purpose}: ${(err as Error).message}`,
    );
  }
}

// -------------------------------------------------------------------------
// Config validation.
// -------------------------------------------------------------------------

function validateConfig(config: LiveHotelbedsClientConfig): void {
  if (!config.apiKey) {
    throw new HotelbedsAdapterError(
      'createLiveHotelbedsClient: apiKey is required',
      'INVALID_CONFIG',
    );
  }
  if (!config.apiSecret) {
    throw new HotelbedsAdapterError(
      'createLiveHotelbedsClient: apiSecret is required',
      'INVALID_CONFIG',
    );
  }
  if (!config.baseUrl) {
    throw new HotelbedsAdapterError(
      'createLiveHotelbedsClient: baseUrl is required',
      'INVALID_CONFIG',
    );
  }
  if (!Number.isFinite(config.requestTimeoutMs) || config.requestTimeoutMs <= 0) {
    throw new HotelbedsAdapterError(
      'createLiveHotelbedsClient: requestTimeoutMs must be a positive number',
      'INVALID_CONFIG',
    );
  }
}

function normalizeBase(base: string): string {
  return base.endsWith('/') ? base.slice(0, -1) : base;
}
