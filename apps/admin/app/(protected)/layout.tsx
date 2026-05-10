import { redirect } from 'next/navigation';
import {
  NotOperatorError,
  UnauthorizedError,
  requireOperatorSession,
} from '../../lib/session';

/**
 * Protected route-group layout (ADR-029 D4 + D6).
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
 *        - `UnauthorizedError`  → redirect to `/auth/login` (the
 *           SDK-mounted Universal Login route — verified at
 *           ADR-029 step 2 against `@auth0/nextjs-auth0` v4.20.0).
 *        - `NotOperatorError`   → redirect to `/not-operator`
 *           (a public-shape static page outside this group).
 *        - any other error      → rethrow; Next surfaces a 5xx via
 *           its default error UI. Loud failure is correct here:
 *           an outage of `/me` should not look like "you're not an
 *           operator", and the request id on a `SessionApiError`
 *           is the bridge to the backend log.
 *
 * This layout owns no client-side state. No tokens are passed to
 * children — server components downstream re-call
 * `requireOperatorSession()` to obtain the typed identity.
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function ProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  try {
    await requireOperatorSession();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      redirect('/auth/login');
    }
    if (err instanceof NotOperatorError) {
      redirect('/not-operator');
    }
    throw err;
  }
  return <>{children}</>;
}
