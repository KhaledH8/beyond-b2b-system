import { requireOperatorSession } from '../../lib/session';

/**
 * Admin home page (ADR-029 step 4 / step 6).
 *
 * The (protected) layout has already validated the operator session and
 * rendered the AdminShell (Header + Sidebar + main). Content here is
 * injected into the shell's <main> — no extra wrapper needed.
 *
 * `requireOperatorSession()` is called a second time to retrieve the
 * typed identity for display. The double /me call per request is
 * accepted for V0.1 operator-grade traffic (ADR-029 D3 latency
 * tradeoff). A future micro-slice can thread the identity through
 * React context if cost shows up in metrics.
 */
export default async function AdminHomePage() {
  const identity = await requireOperatorSession();
  const display = identity.displayName ?? identity.email ?? identity.auth0Sub;

  return (
    <>
      <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
      <p className="mt-2 text-sm text-gray-600">
        Signed in as <strong>{display}</strong>.
      </p>
      <p className="mt-1 text-sm text-gray-500">
        More surfaces ship in subsequent slices.
      </p>
    </>
  );
}
