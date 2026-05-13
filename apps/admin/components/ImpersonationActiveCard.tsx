import { Button } from './Button';
import { Card } from './Card';
import { stopImpersonationAction } from '../app/(protected)/impersonation/actions';
import type { ActiveImpersonationResponse } from '../lib/impersonation-client';

export interface ImpersonationActiveCardProps {
  readonly active: ActiveImpersonationResponse;
}

/**
 * Full active-grant detail card shown on `/impersonation` when a
 * session is currently active. Shows reasonText, startedAt, expiresAt,
 * scope, ticketRef, account id + name, and a Stop button. Wider than
 * the layout banner — this is the dedicated management surface.
 */
export function ImpersonationActiveCard({ active }: ImpersonationActiveCardProps) {
  const { grant, target } = active;

  return (
    <Card title="Active impersonation session">
      <dl
        className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2"
        data-testid="active-card-details"
      >
        <Row label="Target account">
          <span data-testid="active-card-account-name">{target.accountName}</span>
        </Row>
        <Row label="Target account ID">
          <code
            data-testid="active-card-account-id"
            className="rounded bg-gray-100 px-1 py-0.5 font-mono text-xs"
          >
            {target.accountId}
          </code>
        </Row>
        <Row label="Ticket reference">
          <span data-testid="active-card-ticket-ref" className="font-mono">
            {grant.ticketRef}
          </span>
        </Row>
        <Row label="Scope">
          <span data-testid="active-card-scope" className="font-mono text-xs">
            {grant.scope}
          </span>
        </Row>
        <Row label="Started at">
          <time
            data-testid="active-card-started-at"
            dateTime={grant.startedAt}
            className="font-mono text-xs"
          >
            {grant.startedAt}
          </time>
        </Row>
        <Row label="Expires at">
          <time
            data-testid="active-card-expires-at"
            dateTime={grant.expiresAt}
            className="font-mono text-xs"
          >
            {grant.expiresAt}
          </time>
        </Row>
        <Row label="Reason" wide>
          <span data-testid="active-card-reason-text">{grant.reasonText}</span>
        </Row>
      </dl>

      <p className="mt-4 text-xs text-gray-500">
        This is a read-only session per ADR-027. Mutating actions are
        blocked by the backend permission resolver.
      </p>

      <form action={stopImpersonationAction} className="mt-4">
        <Button type="submit" variant="danger">
          Stop impersonation
        </Button>
      </form>
    </Card>
  );
}

function Row({
  label,
  children,
  wide = false,
}: {
  label: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={wide ? 'sm:col-span-2' : undefined}>
      <dt className="text-xs font-medium uppercase text-gray-500">{label}</dt>
      <dd className="mt-0.5 text-sm text-gray-900">{children}</dd>
    </div>
  );
}
