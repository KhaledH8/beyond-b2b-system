import 'server-only';
import { getAccessToken } from './session';
import { loadAdminEnv } from './env';
import { newUlid, validUlid } from './ulid';

/**
 * Server-side API client (ADR-029 step 3 / D5).
 *
 * Public surface:
 *
 *   - `apiFetch<T>(method, path, opts?)` — single entry point for
 *     every backend call from `apps/admin`. Attaches the bearer
 *     token, sets `cache: 'no-store'`, propagates / generates a
 *     `X-Request-Id`, parses JSON safely, and maps every non-2xx
 *     status to a typed `ApiError` subclass carrying the requestId.
 *
 *   - Typed error class hierarchy:
 *       `ApiError` (abstract base)
 *       `ApiUnauthorizedError`   (401 or no token)
 *       `ApiForbiddenError`      (403)
 *       `ApiNotFoundError`       (404)
 *       `ApiConflictError`       (409)
 *       `ApiValidationError`     (400, with parsed body when JSON)
 *       `ApiServerError`         (5xx)
 *       `ApiNetworkError`        (no response / fetch threw)
 *
 * Locked rules (ADR-029 D5 + D6 + D12):
 *
 *   - **Server-side only.** `import 'server-only'` rejects any
 *     client-component import at `next build` time.
 *   - **Caller never passes a token.** The helper calls
 *     `getAccessToken()` from `lib/session.ts` for every request.
 *   - **`cache: 'no-store'` is hard-coded.** It is not a parameter.
 *     Callers cannot opt into caching.
 *   - **No retry.** Retry policy is the caller's concern. The
 *     helper makes one attempt and throws on any non-2xx response.
 *   - **No request/response body logging.** No console output of
 *     bodies even at debug level. Audit-log surfaces (ADR-028) are
 *     where bodies live, not the application log.
 *
 * Request ID:
 *
 *   - If `opts.requestId` is a valid 26-char Crockford-base32 ULID,
 *     it is propagated as `X-Request-Id` on the outbound request.
 *     This is how server components forward an inbound id read
 *     from `next/headers().get('x-request-id')`.
 *   - Otherwise (missing or malformed), a fresh ULID is generated.
 *   - The id used (propagated or generated) is attached to every
 *     `ApiError` as `error.requestId` for support correlation.
 */

// ── HTTP method type ───────────────────────────────────────────────────

export type ApiMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

// ── Typed error hierarchy ──────────────────────────────────────────────

export abstract class ApiError extends Error {
  readonly status?: number;
  readonly requestId: string;
  constructor(message: string, requestId: string, status?: number) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
    this.requestId = requestId;
  }
}

export class ApiUnauthorizedError extends ApiError {
  constructor(requestId: string) {
    super('API returned 401 Unauthorized', requestId, 401);
  }
}

export class ApiForbiddenError extends ApiError {
  constructor(requestId: string) {
    super('API returned 403 Forbidden', requestId, 403);
  }
}

export class ApiNotFoundError extends ApiError {
  constructor(requestId: string) {
    super('API returned 404 Not Found', requestId, 404);
  }
}

export class ApiConflictError extends ApiError {
  constructor(requestId: string) {
    super('API returned 409 Conflict', requestId, 409);
  }
}

/**
 * 400 Bad Request. Carries the parsed JSON body when the response
 * was JSON (so callers can show field-level validation messages);
 * `bodyJson` is `undefined` when the body was missing or not JSON.
 */
export class ApiValidationError extends ApiError {
  readonly bodyJson: unknown;
  constructor(requestId: string, bodyJson: unknown) {
    super('API returned 400 Bad Request', requestId, 400);
    this.bodyJson = bodyJson;
  }
}

export class ApiServerError extends ApiError {
  constructor(requestId: string, status: number) {
    super(`API returned ${status} Server Error`, requestId, status);
  }
}

/**
 * No response received (DNS, TCP, TLS, abort, etc.). The original
 * cause is attached via the standard `Error.cause` so callers can
 * inspect it when needed.
 */
export class ApiNetworkError extends ApiError {
  constructor(message: string, requestId: string, cause?: unknown) {
    super(message, requestId);
    if (cause !== undefined) {
      // ES2022 standard error chaining.
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

// ── apiFetch ───────────────────────────────────────────────────────────

/**
 * Options accepted by `apiFetch`. All are optional in production;
 * the test-injection seam (`getAccessToken`, `fetch`, `apiBaseUrl`)
 * lets unit tests bypass the real SDK and `fetch` without
 * `vi.mock()` ceremony.
 */
export interface ApiFetchOptions {
  /**
   * Request body. JSON-encoded automatically; `Content-Type:
   * application/json` is added only when this is set. Passing
   * `null` or `0` (a valid JSON value) is honoured; `undefined`
   * means no body.
   */
  readonly body?: unknown;

  /**
   * Forward an inbound `X-Request-Id` from the current Next.js
   * server-component context. The value MUST be a valid ULID;
   * anything else is silently replaced with a fresh ULID.
   */
  readonly requestId?: string;

  // ── Test-injection seam (production callers omit) ──────────────────

  /** Override the access-token fetcher (tests pass a fake). */
  readonly getAccessToken?: () => Promise<string>;
  /** Override the global fetch (tests pass a fake). */
  readonly fetch?: typeof fetch;
  /** Override the API base URL (tests bypass `loadAdminEnv()`). */
  readonly apiBaseUrl?: string;
}

/**
 * Single entry point for every backend call from `apps/admin`.
 *
 * Returns the parsed JSON body as `T`, or `undefined` when the
 * response is 204 / empty. Throws `ApiError` on any non-2xx.
 */
export async function apiFetch<T = unknown>(
  method: ApiMethod,
  path: string,
  opts: ApiFetchOptions = {},
): Promise<T> {
  const requestId = validUlid(opts.requestId) ?? newUlid();
  const tokenFn = opts.getAccessToken ?? getAccessToken;
  const fetchFn = opts.fetch ?? fetch;
  const apiBaseUrl = opts.apiBaseUrl ?? loadAdminEnv().api.baseUrl;

  // Acquire bearer. If the SDK throws (no session, refresh failed,
  // etc.) we map that to ApiUnauthorizedError so callers don't need
  // to import session-helper errors to handle the auth boundary.
  let token: string;
  try {
    token = await tokenFn();
  } catch {
    throw new ApiUnauthorizedError(requestId);
  }
  if (!token || token.trim() === '') {
    throw new ApiUnauthorizedError(requestId);
  }

  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    accept: 'application/json',
    'x-request-id': requestId,
  };

  const init: RequestInit = {
    method,
    headers,
    // Hard-coded; not derivable from opts. ADR-029 D6.
    cache: 'no-store',
  };

  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }

  let res: Response;
  try {
    res = await fetchFn(`${apiBaseUrl}${path}`, init);
  } catch (err) {
    throw new ApiNetworkError(
      `Network error calling ${method} ${path}`,
      requestId,
      err,
    );
  }

  if (res.status === 401) throw new ApiUnauthorizedError(requestId);
  if (res.status === 403) throw new ApiForbiddenError(requestId);
  if (res.status === 404) throw new ApiNotFoundError(requestId);
  if (res.status === 409) throw new ApiConflictError(requestId);
  if (res.status === 400) {
    const bodyJson = await safeReadJson(res);
    throw new ApiValidationError(requestId, bodyJson);
  }
  if (res.status >= 500) {
    throw new ApiServerError(requestId, res.status);
  }
  if (!res.ok) {
    // Any other non-2xx (e.g., 3xx surfaced as opaque, 418, 422 in
    // future). Fold into ApiServerError so the caller has a typed
    // boundary; the requestId still correlates with backend logs.
    throw new ApiServerError(requestId, res.status);
  }

  // Empty-body handling. 204 No Content is the canonical shape; some
  // backends send 200 with content-length 0 (e.g., DELETE handlers).
  if (res.status === 204) return undefined as T;
  const lenHeader = res.headers.get('content-length');
  if (lenHeader === '0') return undefined as T;

  // Tolerate empty / non-JSON 2xx bodies. Throwing on parse failure
  // would surface as ApiServerError-flavoured to the caller, which
  // is misleading; the call succeeded, the body was just empty.
  return (await safeReadJson(res)) as T;
}

// ── Internal helpers ───────────────────────────────────────────────────

async function safeReadJson(res: Response): Promise<unknown> {
  // Read as text first so a non-JSON body doesn't throw (e.g., a
  // backend 400 that sent plain text). We deliberately do NOT log
  // the body — ADR-029 D5.
  let text: string;
  try {
    text = await res.text();
  } catch {
    return undefined;
  }
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
