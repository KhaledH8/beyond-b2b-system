/**
 * Static 403 page for non-operator users (ADR-029 D4).
 *
 * Reached when an authenticated AGENCY user (or an operator with
 * no active role, when the API surfaces that signal) lands on the
 * admin app. The user-facing copy does not distinguish "you're an
 * agency user" from "you're an operator without a role" — the
 * audit trail records the difference; the page just communicates
 * the boundary.
 *
 * Lives outside the (protected)/ route group so it renders without
 * triggering `requireOperatorSession()` and the redirect-back loop
 * that would otherwise produce.
 */
export default function NotOperatorPage() {
  return (
    <main>
      <h1>Access denied</h1>
      <p>
        This console is for Beyond Borders staff only. If you are an
        agency user, sign in to the partner portal instead.
      </p>
      <p>
        <a href="/auth/logout">Sign out</a>
      </p>
    </main>
  );
}
