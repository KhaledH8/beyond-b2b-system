/**
 * Auth0 configuration (Slices E2-A + E2-B).
 *
 * Read from env at construction time (fail-fast on missing values
 * for the required E2-A fields), mirroring `InternalAuthGuard` and the
 * FX clients. The values here are written at the Auth0 tenant level
 * when the prod / staging tenants are provisioned (E2 implementation
 * runbook).
 *
 * Required env vars (E2-A — every API instance):
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
 * Optional env vars (E2-B — required only on instances that perform
 * admin provisioning or receive webhooks):
 *
 *   AUTH0_MGMT_CLIENT_ID      M2M application client_id with grants on
 *   AUTH0_MGMT_CLIENT_SECRET  the Management API. Used by the user-
 *                              provisioning service to create / update
 *                              / delete Auth0 users. Absent =>
 *                              admin provisioning endpoints throw at
 *                              call time. We do not fail-fast at boot
 *                              because dev / test stacks may not
 *                              configure them.
 *
 *   AUTH0_MGMT_AUDIENCE       Management API audience. Defaults to
 *                              `${issuerBaseUrl}api/v2/` which is the
 *                              standard Auth0 value; override only if
 *                              the tenant is configured non-standardly.
 *
 *   AUTH0_WEBHOOK_SECRET      HMAC-SHA256 shared secret for verifying
 *                              the Auth0 Log Streams webhook payload.
 *                              Absent => the webhook controller refuses
 *                              every request as "unauthorized" so a
 *                              misconfigured deployment cannot silently
 *                              accept unauthenticated bodies.
 *
 * Custom claims namespace is fixed: 'https://beyondborders.platform/claims/'.
 * Auth0 silently strips custom claims on Auth0-controlled URIs, so
 * the namespace must be one we own.
 */

export const AUTH0_CLAIM_NAMESPACE =
  'https://beyondborders.platform/claims/' as const;

export interface Auth0ManagementConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  /** Standard tenant value: `${issuerBaseUrl}api/v2/`. */
  readonly audience: string;
  /** Standard tenant value: `${issuerBaseUrl}oauth/token`. */
  readonly tokenUrl: string;
}

export interface AuthConfig {
  readonly issuerBaseUrl: string;
  readonly audience: string;
  readonly jwksUri: string;
  readonly bootstrapMode: boolean;
  readonly defaultTenantId: string;
  /** Null when the M2M creds env vars are not set on this instance. */
  readonly management: Auth0ManagementConfig | null;
  /** Null when AUTH0_WEBHOOK_SECRET is not set on this instance. */
  readonly webhookSecret: string | null;
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
    management: parseManagement(issuerBaseUrl),
    webhookSecret: optionalEnv('AUTH0_WEBHOOK_SECRET'),
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

function optionalEnv(name: string): string | null {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) return null;
  return value;
}

function parseManagement(issuerBaseUrl: string): Auth0ManagementConfig | null {
  const clientId = optionalEnv('AUTH0_MGMT_CLIENT_ID');
  const clientSecret = optionalEnv('AUTH0_MGMT_CLIENT_SECRET');
  // All-or-nothing: a half-configured M2M setup is more dangerous than
  // an unconfigured one. If only one of the two is present, we treat it
  // as a config defect and refuse to load — admin provisioning would
  // produce confusing 500s otherwise.
  if (clientId === null && clientSecret === null) return null;
  if (clientId === null || clientSecret === null) {
    throw new Error(
      'AUTH0_MGMT_CLIENT_ID and AUTH0_MGMT_CLIENT_SECRET must be set together; got only one',
    );
  }
  const audience =
    optionalEnv('AUTH0_MGMT_AUDIENCE') ?? `${issuerBaseUrl}api/v2/`;
  const tokenUrl = `${issuerBaseUrl}oauth/token`;
  return { clientId, clientSecret, audience, tokenUrl };
}

function parseBootstrapMode(raw: string | undefined): boolean {
  if (raw === undefined || raw === '' || raw === 'false') return false;
  if (raw === 'true') return true;
  throw new Error(
    `AUTH0_BOOTSTRAP_MODE must be 'true' or 'false' (got "${raw}")`,
  );
}
