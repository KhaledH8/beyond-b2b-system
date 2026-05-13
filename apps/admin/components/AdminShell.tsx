import type { ReactNode } from 'react';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { SystemBanner, type SystemBannerProps } from './SystemBanner';

export interface AdminShellProps {
  /** Resolved display string: name ?? email ?? auth0Sub. Never a token. */
  displayName: string;
  /**
   * Optional active-impersonation banner payload (ADR-027 D11).
   * Threaded straight to `<SystemBanner>` — no tokens, no full session.
   */
  impersonation?: SystemBannerProps['impersonation'];
  children: ReactNode;
}

/**
 * Top-level shell for all authenticated operator pages.
 *
 * Structure (top to bottom / left to right):
 *
 *   SystemBanner   ← ADR-027 impersonation banner when active
 *   Header         ← app name, operator display name, sign-out link
 *   ┌─────────┬────────────────────────────┐
 *   │ Sidebar │ <main> {children} </main>  │
 *   └─────────┴────────────────────────────┘
 *
 * Only safe display data flows in — no tokens, no session objects.
 * The protected layout resolves the operator identity and extracts
 * `displayName` + the impersonation banner payload before passing them.
 */
export function AdminShell({
  displayName,
  impersonation,
  children,
}: AdminShellProps) {
  return (
    <div className="flex min-h-screen flex-col bg-gray-50">
      <SystemBanner impersonation={impersonation} />
      <Header displayName={displayName} />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <main className="flex-1 overflow-auto px-6 py-8">{children}</main>
      </div>
    </div>
  );
}
