import 'server-only';
import { Auth0Client } from '@auth0/nextjs-auth0/server';
import { loadAdminEnv } from './env';

/**
 * Auth0 client singleton (ADR-029 step 2).
 *
 * Constructed lazily on first access so that:
 *
 *   1. Tests that never call `getAuth0Client()` (because they pass
 *      explicit overrides into `requireOperatorSession()`) do not
 *      trigger SDK construction and therefore do not need real
 *      Auth0 env values.
 *   2. The construction error path — missing or malformed env —
 *      surfaces at the first authenticated request rather than at
 *      module-import time, where the stack trace is harder to read.
 *
 * Options are passed explicitly from `loadAdminEnv()` so that ADR-029
 * D8's "no fall-back values, no silent defaults" rule is preserved
 * end-to-end. The SDK's own env fallbacks (`AUTH0_DOMAIN`,
 * `AUTH0_CLIENT_ID`, etc.) are deliberately unused — `loadAdminEnv()`
 * has already validated and normalised those values.
 *
 * `import 'server-only'` makes Next.js fail the build if any client
 * component imports this module — a defence against ADR-029 D12's
 * "no token exposure to client code" rule.
 */

let _client: Auth0Client | undefined;

export function getAuth0Client(): Auth0Client {
  if (_client) return _client;
  const env = loadAdminEnv();
  _client = new Auth0Client({
    domain: env.auth0.domain,
    clientId: env.auth0.clientId,
    clientSecret: env.auth0.clientSecret,
    appBaseUrl: env.auth0.appBaseUrl,
    secret: env.auth0.secret,
    authorizationParameters: {
      audience: env.auth0.audience,
      scope: env.auth0.scope,
    },
  });
  return _client;
}

/**
 * Test-only reset hook. NEVER called from production code paths.
 * Exported (no underscore) intentionally so vitest can mark the
 * client as fresh between tests; the `server-only` import above
 * already prevents client-side reach.
 */
export function __resetAuth0ClientForTests(): void {
  _client = undefined;
}
