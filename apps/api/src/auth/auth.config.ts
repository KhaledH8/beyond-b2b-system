/**
 * Auth0 configuration for Slice E2-A.
 *
 * Read from env at construction time (fail-fast on missing values),
 * mirroring `InternalAuthGuard` and the FX clients. The values here
 * are written at the Auth0 tenant level when the prod / staging
 * tenants are provisioned (E2 implementation runbook).
 *
 * Required env vars:
 *
 *   AUTH0_ISSUER_BASE_URL   the custom domain or default tenant URL,
 *                            e.g. 'https://auth.beyondborders.platform/'
 *                            or  'https://bb-staging-eu.eu.auth0.com/'
 *                            MUST end with a trailing slash to match
 *                            Auth0's `iss` claim exactly.
 *
 *   AUTH0_AUDIENCE           the API identifier, e.g.
 *                            'https://api.beyondborders.platform'.
 *                            Must match the `aud` claim emitted by
 *                            Auth0 for our API.
 *
 *   AUTH0_BOOTSTRAP_MODE     'true' | 'false' (default 'false').
 *                            When 'true', the user-sync layer permits
 *                            JIT user creation for the bootstrap
 *                            `platform_admin`. In every other mode it
 *                            hard-fails on missing user. Locked rule
 *                            from Slice E2-A: JIT is bootstrap-only.
 *
 *   AUTH0_DEFAULT_TENANT_ID  ULID of the tenant new users are bound
 *                            to in single-tenant V1. Future multi-
 *                            tenant routing replaces this with a
 *                            per-token tenant_id claim resolution.
 *
 * Custom claims namespace is fixed: 'https://beyondborders.platform/claims/'.
 * Auth0 silently strips custom claims on Auth0-controlled URIs, so
 * the namespace must be one we own.
 */

export const AUTH0_CLAIM_NAMESPACE =
  'https://beyondborders.platform/claims/' as const;

export interface AuthConfig {
  readonly issuerBaseUrl: string;
  readonly audience: string;
  readonly jwksUri: string;
  readonly bootstrapMode: boolean;
  readonly defaultTenantId: string;
}

export function loadAuthConfig(): AuthConfig {
  const issuerBaseUrl = requireEnv('AUTH0_ISSUER_BASE_URL');
  if (!issuerBaseUrl.endsWith('/')) {
    throw new Error(
      `AUTH0_ISSUER_BASE_URL must end with a trailing slash to match Auth0's 'iss' claim. Got "${issuerBaseUrl}"`,
    );
  }
  return {
    issuerBaseUrl,
    audience: requireEnv('AUTH0_AUDIENCE'),
    jwksUri: `${issuerBaseUrl}.well-known/jwks.json`,
    bootstrapMode: parseBootstrapMode(process.env['AUTH0_BOOTSTRAP_MODE']),
    defaultTenantId: requireEnv('AUTH0_DEFAULT_TENANT_ID'),
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `${name} env var must be a non-empty string — set it before starting the server`,
    );
  }
  return value;
}

function parseBootstrapMode(raw: string | undefined): boolean {
  if (raw === undefined || raw === '' || raw === 'false') return false;
  if (raw === 'true') return true;
  throw new Error(
    `AUTH0_BOOTSTRAP_MODE must be 'true' or 'false' (got "${raw}")`,
  );
}
