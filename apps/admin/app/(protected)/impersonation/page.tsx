import { ImpersonationActiveCard } from '../../../components/ImpersonationActiveCard';
import {
  ImpersonationStartForm,
  type AgencyOption,
} from '../../../components/ImpersonationStartForm';
import {
  getActiveImpersonation,
  listAgencies,
} from '../../../lib/impersonation-client';

/**
 * `/impersonation` — dedicated start/stop/active surface (ADR-027 D10).
 *
 * The layout already gates this route to operators (or impersonating
 * operators per the ADR-029 D4 amendment). The page itself is dumb:
 *
 *   - If a grant is active: render the active card.
 *   - Else: fetch the initial agency list (V1.1 selector, top 20 by
 *     name) and render the start form. The form lets the operator
 *     refine the list via a search action, pick an agency, OR fall
 *     back to manual ULID entry if the selector is unavailable.
 *
 * `dynamic = 'force-dynamic'` mirrors the protected layout — the
 * active-grant check and agency list are not cacheable.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function ImpersonationPage() {
  const active = await getActiveImpersonation();

  if (active) {
    return (
      <>
        <h1 className="text-2xl font-bold text-gray-900">Impersonation</h1>
        <p className="mt-2 text-sm text-gray-600">
          Start, view, or stop a read-only impersonation of an AGENCY
          account in your tenant (ADR-027).
        </p>
        <div className="mt-6">
          <ImpersonationActiveCard active={active} />
        </div>
      </>
    );
  }

  // Initial selector page — top 20 agencies by name. Degrades to an
  // empty list (operator can still use manual mode) on any error.
  let initialAgencies: AgencyOption[] = [];
  try {
    const result = await listAgencies('', 20);
    initialAgencies = result.accounts.map((a) => ({
      id: a.id,
      name: a.name,
      status: a.status,
    }));
  } catch {
    // Selector renders empty; manual fallback still works.
  }

  return (
    <>
      <h1 className="text-2xl font-bold text-gray-900">Impersonation</h1>
      <p className="mt-2 text-sm text-gray-600">
        Start, view, or stop a read-only impersonation of an AGENCY
        account in your tenant (ADR-027).
      </p>
      <div className="mt-6">
        <ImpersonationStartForm initialAgencies={initialAgencies} />
      </div>
    </>
  );
}
