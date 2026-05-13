import { ImpersonationActiveCard } from '../../../components/ImpersonationActiveCard';
import { ImpersonationStartForm } from '../../../components/ImpersonationStartForm';
import { getActiveImpersonation } from '../../../lib/impersonation-client';

/**
 * `/impersonation` — dedicated start/stop/active surface (ADR-027 D10).
 *
 * The layout already gates this route to operators (or impersonating
 * operators per the D4 amendment). The page itself is dumb: it asks
 * the backend whether a grant is active and renders one of two
 * sections. The persistent banner (ADR-027 D11) renders independently
 * via the layout and stays visible while the operator is on this page.
 *
 * `dynamic = 'force-dynamic'` mirrors the protected layout — the
 * active-grant check is not cacheable.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function ImpersonationPage() {
  const active = await getActiveImpersonation();

  return (
    <>
      <h1 className="text-2xl font-bold text-gray-900">Impersonation</h1>
      <p className="mt-2 text-sm text-gray-600">
        Start, view, or stop a read-only impersonation of an AGENCY
        account in your tenant (ADR-027).
      </p>

      <div className="mt-6">
        {active ? (
          <ImpersonationActiveCard active={active} />
        ) : (
          <ImpersonationStartForm />
        )}
      </div>
    </>
  );
}
