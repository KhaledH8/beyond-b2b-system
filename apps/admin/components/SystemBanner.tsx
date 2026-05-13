import { ImpersonationBanner } from './ImpersonationBanner';

export interface SystemBannerProps {
  /**
   * Set when the operator session has an active impersonation grant.
   * Rendered via `<ImpersonationBanner>` (ADR-027 D11). The layout
   * resolves this from `GET /impersonation/active`; only safe display
   * data is threaded in — no tokens, no full session.
   */
  readonly impersonation?: {
    readonly accountName: string;
    readonly accountId: string;
    readonly ticketRef: string;
    readonly expiresAt: string;
  };
}

/**
 * Slot for system-wide operator alerts in the AdminShell. Today only
 * the ADR-027 impersonation banner mounts here. Returns null when
 * there is nothing to show (no DOM nodes, no visual whitespace).
 */
export function SystemBanner({ impersonation }: SystemBannerProps = {}) {
  if (!impersonation) return null;
  return <ImpersonationBanner {...impersonation} />;
}
