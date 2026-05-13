import { redirect } from 'next/navigation';
import { AdminShell } from '../../components/AdminShell';
import { getActiveImpersonation } from '../../lib/impersonation-client';
import {
  NotOperatorError,
  UnauthorizedError,
  requireOperatorSession,
} from '../../lib/session';

/**
 * Protected route-group layout (ADR-029 D4 + D6 + step 6 shell).
 *
 * Every authenticated admin route is rendered through this layout.
 * On every request:
 *
 *   1. `dynamic = 'force-dynamic'` + `revalidate = 0` disable
 *      Next's static caching for everything under (protected)/.
 *      ADR-029 D6: an operator-class check must never be served
 *      from a stale render.
 *
 *   2. `requireOperatorSession()` validates the session, acquires
 *      an access token, and confirms via `/me` that the caller is
 *      an OPERATOR — or an OPERATOR currently impersonating an
 *      AGENCY (ADR-029 D4 amendment 2026-05-10).
 *
 *   3. When `identity.impersonation` is present, call
 *      `getActiveImpersonation()` to fetch the target's account
 *      name + ticket ref + expiry for the persistent banner
 *      (ADR-027 D11). On 5xx or network failure, the layout
 *      degrades gracefully (no banner; the rest of the app still
 *      renders). On `null` (grant raced the layout — expired
 *      between /me and /impersonation/active), same outcome.
 *
 *   4. Error mapping for `requireOperatorSession`:
 *        - `UnauthorizedError`  → redirect to `/auth/login`
 *        - `NotOperatorError`   → redirect to `/not-operator`
 *        - any other error      → rethrow (5xx, network outage)
 *
 *   5. Only safe display data (displayName string + banner payload
 *      with accountName / accountId / ticketRef / expiresAt) is
 *      forwarded to the shell. No tokens, no session objects, no
 *      accountId reach client code (ADR-029 D12).
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function ProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  let identity: Awaited<ReturnType<typeof requireOperatorSession>>;
  try {
    identity = await requireOperatorSession();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      redirect('/auth/login');
    }
    if (err instanceof NotOperatorError) {
      redirect('/not-operator');
    }
    throw err;
  }

  const displayName =
    identity.displayName ?? identity.email ?? identity.auth0Sub;

  let impersonationBanner:
    | {
        accountName: string;
        accountId: string;
        ticketRef: string;
        expiresAt: string;
      }
    | undefined;

  if (identity.impersonation) {
    try {
      const active = await getActiveImpersonation();
      if (active) {
        impersonationBanner = {
          accountName: active.target.accountName,
          accountId: active.target.accountId,
          ticketRef: active.grant.ticketRef,
          expiresAt: active.grant.expiresAt,
        };
      }
      // active === null: /me said impersonating but the grant raced
      // (e.g., expired between calls). Render no banner; do not crash.
    } catch {
      // 5xx / network: degrade gracefully. The Stop button is still
      // reachable via /impersonation (where the page surfaces its own
      // error if applicable). The rest of the app renders.
    }
  }

  return (
    <AdminShell displayName={displayName} impersonation={impersonationBanner}>
      {children}
    </AdminShell>
  );
}
