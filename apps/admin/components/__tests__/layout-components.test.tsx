// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AdminShell } from '../AdminShell';
import { Header } from '../Header';
import { Sidebar } from '../Sidebar';
import { SystemBanner } from '../SystemBanner';

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
  it('H — renders no visible content in step 6', () => {
    const { container } = render(<SystemBanner />);
    // null renders as empty — no DOM nodes inside the container div.
    expect(container.firstChild).toBeNull();
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
});
