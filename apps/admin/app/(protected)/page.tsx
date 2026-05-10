import { requireOperatorSession } from '../../lib/session';

/**
 * Admin home page (ADR-029 step 4).
 *
 * The (protected) layout has already validated the operator session
 * before this page renders. We call `requireOperatorSession()` again
 * here only to retrieve the typed identity for display. The double
 * `/me` call per request is acceptable for V0.1 operator-grade
 * traffic — see ADR-029 D3's "Latency tradeoff, accepted explicitly"
 * block. A future micro-slice can pass the identity through the
 * layout via React context if the cost ever shows up in metrics.
 *
 * V0.1 has no real navigation. Subsequent slices add the layout's
 * Sidebar (step 6) and the impersonation surface (next ADR-027 UI
 * slice).
 */
export default async function AdminHomePage() {
  const identity = await requireOperatorSession();
  const display = identity.displayName ?? identity.email ?? identity.auth0Sub;

  return (
    <main>
      <h1>Beyond Borders — Admin</h1>
      <p>
        Signed in as <strong>{display}</strong>.
      </p>
      <p>
        This console is operator-only. More surfaces ship in
        subsequent slices.
      </p>
      <p>
        <a href="/auth/logout">Sign out</a>
      </p>
    </main>
  );
}
