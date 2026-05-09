import 'server-only';
import type { SessionData } from '@auth0/nextjs-auth0/types';
import { getAuth0Client } from './auth0';
import { loadAdminEnv } from './env';

/**
 * Server-side session helper (ADR-029 step 2 / D3).
 *
 * Public surface:
 *
 *   - `getSession()`              — wraps `auth0.getSession()`.
 *   - `getAccessToken()`          — wraps `auth0.getAccessToken()`.
 *   - `requireOperatorSession()`  — composes both, fetches `/me`, and
 *                                    asserts the caller is an OPERATOR.
 *
 * `import 'server-only'` ensures Next.js fails the build if any
 * client component imports this module — a hard defence against
 * ADR-029 D12's "no token exposure to client code" rule.
 *
 * Every server component, server action, and route handler in
 * `apps/admin` MUST go through `requireOperatorSession()` (or the
 * lower-level helpers when a more specialised flow is justified).
 * Direct calls to `auth0.getSession()` outside this module are
 * forbidden by ADR-029 D3.
 */

// ── Typed errors ────────────────────────────────────────────────────────

/**
 * No valid session, or the session lookup failed in a way that
 * prevents identifying the user. Maps to a 401-equivalent UX
 * response (redirect to login).
 */
export class UnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

/**
 * The caller is authenticated but is NOT an operator (or holds no
 * active operator role when role data is available). Maps to a 403
 * UX response (`/not-operator` static page).
 */
export class NotOperatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotOperatorError';
  }
}

/**
 * `/me` was unreachable or returned a non-401/403 error response.
 * Distinguished from `UnauthorizedError` so a 5xx outage shows a
 * different page than a permission denial.
 */
export class SessionApiError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'SessionApiError';
    this.status = status;
  }
}

// ── /me response shape ─────────────────────────────────────────────────

/**
 * The shape of `GET /me` (mirrors `AuthContext` from the API).
 * `roles` is forward-compat: the API's `MeController` does not return
 * roles today, but the type accommodates them so this helper can
 * enforce the "no active operator role" rule when the API adds the
 * field. ADR-029 D4 covers this transition.
 */
export interface MeResponse {
  readonly auth0Sub: string;
  readonly userId: string;
  readonly tenantId: string;
  readonly accountId: string | null;
  readonly userClass: 'OPERATOR' | 'AGENCY';
  readonly roles?: readonly string[];
  readonly impersonation?: unknown;
}

// ── Operator identity returned by requireOperatorSession ───────────────

export interface OperatorIdentity {
  readonly userId: string;
  readonly auth0Sub: string;
  readonly tenantId: string;
  readonly email: string | undefined;
  readonly displayName: string | undefined;
  readonly roles: readonly string[] | undefined;
}

// ── Public helpers ─────────────────────────────────────────────────────

export async function getSession(): Promise<SessionData | null> {
  return getAuth0Client().getSession();
}

export async function getAccessToken(): Promise<string> {
  const result = await getAuth0Client().getAccessToken();
  return result.token;
}

// ── requireOperatorSession with override-injection for testability ─────

/**
 * Hooks that tests inject to bypass the real Auth0 SDK and `fetch`.
 * Production callers omit this argument and get the real wiring.
 */
export interface RequireOperatorSessionOverrides {
  readonly getSession?: () => Promise<SessionData | null>;
  readonly getAccessToken?: () => Promise<string>;
  readonly fetch?: typeof fetch;
  readonly apiBaseUrl?: string;
}

/**
 * Resolves the operator identity for the current request.
 *
 * Order of operations (ADR-029 D3):
 *
 *   1. Read the session (server-only). Missing → `UnauthorizedError`.
 *   2. Acquire an access token. Missing/empty → `UnauthorizedError`.
 *   3. Call backend `/me` with `Authorization: Bearer <token>` and
 *      `cache: 'no-store'` (D6 — never serve a stale impersonation
 *      banner from cached `/me` HTML).
 *   4. Map status:
 *        - 401 / 403 → `UnauthorizedError`
 *        - 5xx / network error → `SessionApiError`
 *        - 2xx with `userClass !== 'OPERATOR'` → `NotOperatorError`
 *        - 2xx with `roles` array present and empty → `NotOperatorError`
 *        - 2xx with `userClass === 'OPERATOR'` → success
 *   5. Return the typed `OperatorIdentity`.
 *
 * The function never returns `null`; callers that need optional
 * behaviour should catch the typed error.
 */
export async function requireOperatorSession(
  overrides?: RequireOperatorSessionOverrides,
): Promise<OperatorIdentity> {
  const sessionFn = overrides?.getSession ?? getSession;
  const tokenFn = overrides?.getAccessToken ?? getAccessToken;
  const fetchFn = overrides?.fetch ?? fetch;
  const apiBaseUrl = overrides?.apiBaseUrl ?? loadAdminEnv().api.baseUrl;

  const session = await sessionFn();
  if (!session) {
    throw new UnauthorizedError('No active session');
  }

  let token: string;
  try {
    token = await tokenFn();
  } catch (err) {
    throw new UnauthorizedError(
      `Failed to obtain access token: ${(err as Error).message ?? 'unknown'}`,
    );
  }
  if (!token || token.trim() === '') {
    throw new UnauthorizedError('Empty access token');
  }

  let res: Response;
  try {
    res = await fetchFn(`${apiBaseUrl}/me`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
      },
      cache: 'no-store',
    });
  } catch (err) {
    throw new SessionApiError(
      `/me network error: ${(err as Error).message ?? 'unknown'}`,
    );
  }

  if (res.status === 401 || res.status === 403) {
    throw new UnauthorizedError(`/me returned ${res.status}`);
  }
  if (!res.ok) {
    throw new SessionApiError(`/me returned ${res.status}`, res.status);
  }

  let me: MeResponse;
  try {
    me = (await res.json()) as MeResponse;
  } catch (err) {
    throw new SessionApiError(
      `/me returned invalid JSON: ${(err as Error).message ?? 'unknown'}`,
    );
  }

  if (me.userClass !== 'OPERATOR') {
    throw new NotOperatorError(
      `User ${me.userId} has userClass=${me.userClass}; admin app requires OPERATOR`,
    );
  }
  // Forward-compat: when /me starts returning roles, an empty array
  // means "no active operator role" — reject. When the field is
  // absent, we accept (the userClass alone is the gate today).
  if (Array.isArray(me.roles) && me.roles.length === 0) {
    throw new NotOperatorError(
      `Operator ${me.userId} has no active role`,
    );
  }

  return {
    userId: me.userId,
    auth0Sub: me.auth0Sub,
    tenantId: me.tenantId,
    email: typeof session.user.email === 'string' ? session.user.email : undefined,
    displayName: typeof session.user.name === 'string' ? session.user.name : undefined,
    roles: me.roles,
  };
}
