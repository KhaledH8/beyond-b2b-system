/**
 * Admin app environment validator (ADR-029 step 1).
 *
 * Loud-fail on missing or malformed required variables. No fallback
 * defaults. No silent coercion. Every variable is one of:
 *
 *   - Required and validated (URL-shape, ULID-shape, non-empty string).
 *   - Required and presence-only (the SDK or runtime will validate
 *     deeper semantics).
 *
 * Variable names follow `@auth0/nextjs-auth0` v4 conventions (verified
 * against the V4 migration guide on 2026-05-10). See
 * `apps/admin/README.md` § "Auth0 SDK route + env-name verification".
 *
 * This module exports:
 *
 *   - `loadAdminEnv(source?)` — reads from `process.env` (or a passed
 *     record for tests), validates, returns the typed `AdminEnv` shape.
 *     Throws `AdminEnvError` on the first failure with a one-line,
 *     ops-readable message that names the offending variable.
 *
 *   - `AdminEnv` — the typed shape consumers receive.
 *
 *   - `AdminEnvError` — the thrown error type.
 *
 * No code outside `lib/env.ts` touches `process.env` for these
 * variables. Subsequent ADR-029 steps (auth, API client, layout)
 * call `loadAdminEnv()` once at module init and pass the typed
 * value down.
 */

export interface AdminEnv {
  readonly auth0: {
    readonly secret: string;
    readonly appBaseUrl: string;
    readonly domain: string;
    readonly clientId: string;
    readonly clientSecret: string;
    readonly audience: string;
    readonly scope: string;
  };
  readonly api: {
    readonly baseUrl: string;
  };
  readonly tenantId: string;
}

export class AdminEnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdminEnvError';
  }
}

/** 26-char Crockford base32 (ULID format), matching ADR-028's middleware. */
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Loads and validates the admin app's environment.
 *
 * @param source Optional record (defaults to `process.env`). Tests pass
 *   an explicit object so they don't have to mutate the real env.
 * @throws AdminEnvError on the first invalid or missing required
 *   variable; the message names the variable so ops can fix it
 *   without diving into stack traces.
 */
export function loadAdminEnv(
  source: Record<string, string | undefined> = process.env,
): AdminEnv {
  const secret = requireNonEmpty(source, 'AUTH0_SECRET');
  const appBaseUrl = requireUrl(source, 'APP_BASE_URL');
  const domain = requireAuth0Domain(source, 'AUTH0_DOMAIN');
  const clientId = requireNonEmpty(source, 'AUTH0_CLIENT_ID');
  const clientSecret = requireNonEmpty(source, 'AUTH0_CLIENT_SECRET');
  const audience = requireUrl(source, 'AUTH0_AUDIENCE');
  const scope = requireScope(source, 'AUTH0_SCOPE');
  const apiBaseUrl = requireUrl(source, 'BB_API_BASE_URL');
  const tenantId = requireUlid(source, 'BB_TENANT_ID');

  return {
    auth0: {
      secret,
      appBaseUrl,
      domain,
      clientId,
      clientSecret,
      audience,
      scope,
    },
    api: { baseUrl: apiBaseUrl },
    tenantId,
  };
}

// ── Validators ──────────────────────────────────────────────────────────

function requireNonEmpty(
  source: Record<string, string | undefined>,
  name: string,
): string {
  const raw = source[name];
  if (raw === undefined || raw.trim() === '') {
    throw new AdminEnvError(`${name} is required and must be a non-empty string`);
  }
  return raw;
}

function requireUrl(
  source: Record<string, string | undefined>,
  name: string,
): string {
  const raw = requireNonEmpty(source, name);
  try {
    // Constructor throws on malformed URLs.
    // We accept any well-formed URL; HTTPS is enforced by Auth0
    // at the application-config level, not here.
    new URL(raw);
  } catch {
    throw new AdminEnvError(`${name} must be a well-formed URL; received: "${raw}"`);
  }
  return raw;
}

/**
 * AUTH0_DOMAIN must be a hostname only — no scheme, no path, no
 * trailing slash. The SDK rejects misshapen values at boot, but
 * catching it here gives a clearer error.
 */
function requireAuth0Domain(
  source: Record<string, string | undefined>,
  name: string,
): string {
  const raw = requireNonEmpty(source, name);
  if (raw.includes('://')) {
    throw new AdminEnvError(
      `${name} must be a hostname only, with no scheme; received: "${raw}"`,
    );
  }
  if (raw.includes('/')) {
    throw new AdminEnvError(
      `${name} must be a hostname only, with no path; received: "${raw}"`,
    );
  }
  // Reject if it doesn't look like a domain (no dot at all).
  if (!raw.includes('.')) {
    throw new AdminEnvError(
      `${name} must be a fully-qualified domain (must contain a "."); received: "${raw}"`,
    );
  }
  return raw;
}

/**
 * AUTH0_SCOPE must be a non-empty space-separated list that includes
 * `openid` (required by OIDC). V0.1 also rejects `offline_access`
 * per ADR-029 D8 — refresh tokens are not requested in V0.1.
 */
function requireScope(
  source: Record<string, string | undefined>,
  name: string,
): string {
  const raw = requireNonEmpty(source, name);
  const scopes = raw.split(/\s+/).filter((s) => s.length > 0);
  if (!scopes.includes('openid')) {
    throw new AdminEnvError(
      `${name} must include the "openid" scope; received: "${raw}"`,
    );
  }
  if (scopes.includes('offline_access')) {
    throw new AdminEnvError(
      `${name} must NOT include "offline_access" in V0.1 (ADR-029 D8). ` +
        `If refresh tokens are required, write the ADR amendment first.`,
    );
  }
  return scopes.join(' ');
}

function requireUlid(
  source: Record<string, string | undefined>,
  name: string,
): string {
  const raw = requireNonEmpty(source, name);
  if (!ULID_PATTERN.test(raw)) {
    throw new AdminEnvError(
      `${name} must be a 26-character Crockford base32 ULID; received: "${raw}"`,
    );
  }
  return raw;
}
