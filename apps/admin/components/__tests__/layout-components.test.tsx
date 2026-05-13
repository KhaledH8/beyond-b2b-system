// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// SystemBanner now transitively imports the server actions file, which
// imports next/cache and next/navigation. Those are runtime-only in
// production; mock them here so the modules load cleanly in happy-dom.
vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  redirect: vi.fn(() => {
    throw new Error('mock redirect');
  }),
}));

import { AdminShell } from '../AdminShell';
import { Header } from '../Header';
import { ImpersonationActiveCard } from '../ImpersonationActiveCard';
import { ImpersonationBanner } from '../ImpersonationBanner';
import { ImpersonationStartForm } from '../ImpersonationStartForm';
import { Sidebar } from '../Sidebar';
import { SystemBanner } from '../SystemBanner';
import type { ActiveImpersonationResponse } from '../../lib/impersonation-client';

const IMPERSONATION_FIXTURE = {
  accountName: 'Acme Travel',
  accountId: '01ARZ3NDEKTSV4RRFFQ69G5TGT',
  ticketRef: 'SUP-1234',
  expiresAt: '2026-05-10T10:30:00.000Z',
};

const ACTIVE_FIXTURE: ActiveImpersonationResponse = {
  grant: {
    id: '01ARZ3NDEKTSV4RRFFQ69G5GRA',
    tenantId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    actorUserId: '01ARZ3NDEKTSV4RRFFQ69G5OPE',
    targetAccountId: IMPERSONATION_FIXTURE.accountId,
    reasonText: 'Investigating ticket SUP-1234',
    ticketRef: IMPERSONATION_FIXTURE.ticketRef,
    scope: 'READ_ONLY',
    startedAt: '2026-05-10T10:00:00.000Z',
    expiresAt: IMPERSONATION_FIXTURE.expiresAt,
    endedAt: null,
    endedReason: null,
    ipAddress: null,
    userAgent: null,
  },
  target: {
    accountId: IMPERSONATION_FIXTURE.accountId,
    accountName: IMPERSONATION_FIXTURE.accountName,
  },
};

// ── Header ────────────────────────────────────────────────────────────

describe('Header', () => {
  it('A — renders "Beyond Borders" label', () => {
    render(<Header displayName="Op Person" />);
    expect(screen.getByText('Beyond Borders')).toBeInTheDocument();
  });

  it('B — renders "Admin" sub-label', () => {
    render(<Header displayName="Op Person" />);
    expect(screen.getByText('Admin')).toBeInTheDocument();
  });

  it('C — renders operator display name', () => {
    render(<Header displayName="Op Person" />);
    expect(screen.getByText('Op Person')).toBeInTheDocument();
  });

  it('D — renders email when passed as displayName', () => {
    render(<Header displayName="op@bb.test" />);
    expect(screen.getByText('op@bb.test')).toBeInTheDocument();
  });

  it('E — sign-out link points to /auth/logout', () => {
    render(<Header displayName="Op Person" />);
    const link = screen.getByRole('link', { name: /sign out/i });
    expect(link).toHaveAttribute('href', '/auth/logout');
  });

  it('F — sign-out link is accessible via keyboard (visible focus)', () => {
    render(<Header displayName="Op Person" />);
    const link = screen.getByRole('link', { name: /sign out/i });
    // Focus-visible classes are present in the className (CSS-level).
    // We verify the element is a real anchor so the browser focus ring
    // can apply.
    expect(link.tagName).toBe('A');
  });

  it('G — renders optional actions slot when provided', () => {
    render(
      <Header displayName="Op Person" actions={<button>Extra</button>} />,
    );
    expect(screen.getByRole('button', { name: 'Extra' })).toBeInTheDocument();
  });
});

// ── SystemBanner ──────────────────────────────────────────────────────

describe('SystemBanner', () => {
  it('H — renders no visible content when no impersonation prop', () => {
    const { container } = render(<SystemBanner />);
    // null renders as empty — no DOM nodes inside the container div.
    expect(container.firstChild).toBeNull();
  });

  it('H2 — renders the ImpersonationBanner when impersonation prop is provided', () => {
    render(<SystemBanner impersonation={IMPERSONATION_FIXTURE} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(
      screen.getByTestId('banner-account-name'),
    ).toHaveTextContent('Acme Travel');
  });
});

// ── Sidebar ───────────────────────────────────────────────────────────

describe('Sidebar', () => {
  it('I — renders a navigation landmark', () => {
    render(<Sidebar />);
    expect(screen.getByRole('navigation')).toBeInTheDocument();
  });

  it('J — navigation has accessible label "Main navigation"', () => {
    render(<Sidebar />);
    expect(
      screen.getByRole('navigation', { name: 'Main navigation' }),
    ).toBeInTheDocument();
  });

  it('K — renders Home link pointing to /', () => {
    render(<Sidebar />);
    const link = screen.getByRole('link', { name: 'Home' });
    expect(link).toHaveAttribute('href', '/');
  });

  it('K2 — renders Impersonation link pointing to /impersonation', () => {
    render(<Sidebar />);
    const link = screen.getByRole('link', { name: 'Impersonation' });
    expect(link).toHaveAttribute('href', '/impersonation');
  });
});

// ── AdminShell ────────────────────────────────────────────────────────

describe('AdminShell', () => {
  it('L — renders header landmark', () => {
    render(<AdminShell displayName="Op Person">content</AdminShell>);
    expect(screen.getByRole('banner')).toBeInTheDocument();
  });

  it('M — renders navigation landmark (sidebar)', () => {
    render(<AdminShell displayName="Op Person">content</AdminShell>);
    expect(screen.getByRole('navigation')).toBeInTheDocument();
  });

  it('N — renders main landmark', () => {
    render(<AdminShell displayName="Op Person">content</AdminShell>);
    expect(screen.getByRole('main')).toBeInTheDocument();
  });

  it('O — children appear inside the main landmark', () => {
    render(
      <AdminShell displayName="Op Person">
        <p>Page content</p>
      </AdminShell>,
    );
    const main = screen.getByRole('main');
    expect(main).toHaveTextContent('Page content');
  });

  it('P — operator display name visible in header', () => {
    render(<AdminShell displayName="Test Operator">content</AdminShell>);
    expect(screen.getByText('Test Operator')).toBeInTheDocument();
  });

  it('Q — sign-out link is present in the shell', () => {
    render(<AdminShell displayName="Op Person">content</AdminShell>);
    expect(
      screen.getByRole('link', { name: /sign out/i }),
    ).toHaveAttribute('href', '/auth/logout');
  });

  it('R — Home link is present in the shell', () => {
    render(<AdminShell displayName="Op Person">content</AdminShell>);
    expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute(
      'href',
      '/',
    );
  });

  it('R2 — renders ImpersonationBanner when impersonation prop is provided', () => {
    render(
      <AdminShell displayName="Op Person" impersonation={IMPERSONATION_FIXTURE}>
        content
      </AdminShell>,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByTestId('banner-account-name')).toHaveTextContent(
      'Acme Travel',
    );
  });
});

// ── ImpersonationBanner ───────────────────────────────────────────────

describe('ImpersonationBanner', () => {
  it('S — renders as a danger alert (role=alert)', () => {
    render(<ImpersonationBanner {...IMPERSONATION_FIXTURE} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('T — shows target account name', () => {
    render(<ImpersonationBanner {...IMPERSONATION_FIXTURE} />);
    expect(screen.getByTestId('banner-account-name')).toHaveTextContent(
      'Acme Travel',
    );
  });

  it('U — shows target account ID', () => {
    render(<ImpersonationBanner {...IMPERSONATION_FIXTURE} />);
    expect(screen.getByTestId('banner-account-id')).toHaveTextContent(
      IMPERSONATION_FIXTURE.accountId,
    );
  });

  it('V — shows ticket reference', () => {
    render(<ImpersonationBanner {...IMPERSONATION_FIXTURE} />);
    expect(screen.getByTestId('banner-ticket-ref')).toHaveTextContent(
      'SUP-1234',
    );
  });

  it('W — shows expiry time as a <time> with dateTime', () => {
    render(<ImpersonationBanner {...IMPERSONATION_FIXTURE} />);
    const time = screen.getByTestId('banner-expires-at');
    expect(time.tagName).toBe('TIME');
    expect(time).toHaveAttribute('dateTime', IMPERSONATION_FIXTURE.expiresAt);
  });

  it('X — shows the read-only warning text', () => {
    render(<ImpersonationBanner {...IMPERSONATION_FIXTURE} />);
    expect(screen.getByText(/read-only session/i)).toBeInTheDocument();
  });

  it('Y — includes an End-impersonation submit button inside a form', () => {
    const { container } = render(<ImpersonationBanner {...IMPERSONATION_FIXTURE} />);
    const button = screen.getByRole('button', { name: /end impersonation/i });
    expect(button).toHaveAttribute('type', 'submit');
    // Button must be wrapped in a form for the server action to fire.
    expect(container.querySelector('form')).not.toBeNull();
  });
});

// ── ImpersonationActiveCard ───────────────────────────────────────────

describe('ImpersonationActiveCard', () => {
  it('Z — renders target account name', () => {
    render(<ImpersonationActiveCard active={ACTIVE_FIXTURE} />);
    expect(screen.getByTestId('active-card-account-name')).toHaveTextContent(
      'Acme Travel',
    );
  });

  it('AA — renders target account ID', () => {
    render(<ImpersonationActiveCard active={ACTIVE_FIXTURE} />);
    expect(screen.getByTestId('active-card-account-id')).toHaveTextContent(
      IMPERSONATION_FIXTURE.accountId,
    );
  });

  it('BB — renders ticket reference', () => {
    render(<ImpersonationActiveCard active={ACTIVE_FIXTURE} />);
    expect(screen.getByTestId('active-card-ticket-ref')).toHaveTextContent(
      'SUP-1234',
    );
  });

  it('CC — renders reason text', () => {
    render(<ImpersonationActiveCard active={ACTIVE_FIXTURE} />);
    expect(screen.getByTestId('active-card-reason-text')).toHaveTextContent(
      'Investigating ticket SUP-1234',
    );
  });

  it('DD — renders startedAt and expiresAt as <time> elements with dateTime', () => {
    render(<ImpersonationActiveCard active={ACTIVE_FIXTURE} />);
    expect(screen.getByTestId('active-card-started-at')).toHaveAttribute(
      'dateTime',
      ACTIVE_FIXTURE.grant.startedAt,
    );
    expect(screen.getByTestId('active-card-expires-at')).toHaveAttribute(
      'dateTime',
      ACTIVE_FIXTURE.grant.expiresAt,
    );
  });

  it('EE — renders scope=READ_ONLY', () => {
    render(<ImpersonationActiveCard active={ACTIVE_FIXTURE} />);
    expect(screen.getByTestId('active-card-scope')).toHaveTextContent(
      'READ_ONLY',
    );
  });

  it('FF — includes a Stop impersonation submit button inside a form', () => {
    const { container } = render(<ImpersonationActiveCard active={ACTIVE_FIXTURE} />);
    const button = screen.getByRole('button', { name: /stop impersonation/i });
    expect(button).toHaveAttribute('type', 'submit');
    expect(container.querySelector('form')).not.toBeNull();
  });
});

// ── ImpersonationStartForm ────────────────────────────────────────────

describe('ImpersonationStartForm', () => {
  it('GG — renders the Target account ID input (with name and helper text)', () => {
    render(<ImpersonationStartForm />);
    const input = screen.getByLabelText(/target account id/i);
    expect(input).toHaveAttribute('name', 'targetAccountId');
    expect(screen.getByText(/no agency selector yet/i)).toBeInTheDocument();
  });

  it('HH — renders the Ticket reference input', () => {
    render(<ImpersonationStartForm />);
    const input = screen.getByLabelText(/ticket reference/i);
    expect(input).toHaveAttribute('name', 'ticketRef');
  });

  it('II — renders the Reason textarea', () => {
    render(<ImpersonationStartForm />);
    const textarea = screen.getByLabelText(/^reason$/i);
    expect(textarea.tagName).toBe('TEXTAREA');
    expect(textarea).toHaveAttribute('name', 'reasonText');
  });

  it('JJ — renders a Start impersonation submit button', () => {
    render(<ImpersonationStartForm />);
    const button = screen.getByRole('button', { name: /start impersonation/i });
    expect(button).toHaveAttribute('type', 'submit');
  });
});
