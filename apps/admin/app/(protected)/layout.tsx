import { redirect } from 'next/navigation';
import { AdminShell } from '../../components/AdminShell';
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
 *      an access token, and confirms via `/me` that the caller
 *      is an OPERATOR.
 *
 *   3. Error mapping:
 *        - `UnauthorizedError`  → redirect to `/auth/login`
 *        - `NotOperatorError`   → redirect to `/not-operator`
 *        - any other error      → rethrow (5xx, network outage)
 *
 *   4. Only safe display data (name / email / auth0Sub string) is
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

  return <AdminShell displayName={displayName}>{children}</AdminShell>;
}
