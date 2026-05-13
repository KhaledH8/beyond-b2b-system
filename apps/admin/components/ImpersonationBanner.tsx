import { Banner } from './Banner';
import { Button } from './Button';
import { stopImpersonationAction } from '../app/(protected)/impersonation/actions';

export interface ImpersonationBannerProps {
  /** Target account display name (e.g. "Acme Travel"). */
  readonly accountName: string;
  /** Target account ULID (shown verbatim for operator verification). */
  readonly accountId: string;
  /** Support ticket reference from the start request. */
  readonly ticketRef: string;
  /** ISO-8601 grant expiry timestamp. */
  readonly expiresAt: string;
}

/**
 * Persistent, non-dismissable banner mandated by ADR-027 D11. Renders
 * on every authenticated operator page when the session has an active
 * impersonation grant. Includes the End-impersonation submit form so
 * the operator can stop from any page without navigating first.
 *
 * Server component: no `'use client'`, no client-side fetch. The Stop
 * button is a `<Button type="submit">` inside a `<form>` posting to a
 * server action — the server action calls the backend and revalidates
 * the layout, which causes this banner to disappear on the next render.
 */
export function ImpersonationBanner({
  accountName,
  accountId,
  ticketRef,
  expiresAt,
}: ImpersonationBannerProps) {
  return (
    <Banner variant="danger" className="rounded-none border-x-0 border-t-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <div className="font-semibold">
            Impersonating <span data-testid="banner-account-name">{accountName}</span>{' '}
            (read-only)
          </div>
          <div className="text-xs">
            Account ID:{' '}
            <code
              data-testid="banner-account-id"
              className="rounded bg-red-100 px-1 py-0.5 font-mono"
            >
              {accountId}
            </code>
            {' · '}
            Ticket:{' '}
            <span data-testid="banner-ticket-ref" className="font-mono">
              {ticketRef}
            </span>
            {' · '}
            Expires at{' '}
            <time data-testid="banner-expires-at" dateTime={expiresAt}>
              {expiresAt}
            </time>
          </div>
          <div className="text-xs italic">
            Read-only session per ADR-027. Mutating actions are blocked.
          </div>
        </div>
        <form action={stopImpersonationAction}>
          <Button type="submit" variant="danger" size="sm">
            End impersonation
          </Button>
        </form>
      </div>
    </Banner>
  );
}
