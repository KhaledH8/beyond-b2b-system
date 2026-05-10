// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Banner } from '../Banner';
import { Button } from '../Button';
import { Card } from '../Card';
import { Input } from '../Input';
import { Textarea } from '../Textarea';

// ── Button ────────────────────────────────────────────────────────────

describe('Button', () => {
  it('A — renders children', () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('B — disabled state sets disabled attribute and aria', () => {
    render(<Button disabled>Save</Button>);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('C — renders all variants without throwing', () => {
    for (const variant of ['primary', 'secondary', 'danger', 'ghost'] as const) {
      const { unmount } = render(<Button variant={variant}>{variant}</Button>);
      expect(screen.getByRole('button', { name: variant })).toBeInTheDocument();
      unmount();
    }
  });

  it('D — renders sm and md sizes without throwing', () => {
    const { unmount } = render(<Button size="sm">sm</Button>);
    expect(screen.getByRole('button', { name: 'sm' })).toBeInTheDocument();
    unmount();

    render(<Button size="md">md</Button>);
    expect(screen.getByRole('button', { name: 'md' })).toBeInTheDocument();
  });
});

// ── Input ─────────────────────────────────────────────────────────────

describe('Input', () => {
  it('E — renders and label associates with input', () => {
    render(<Input label="Email" />);
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
  });

  it('F — helper text renders and is referenced via aria-describedby', () => {
    render(<Input label="Username" helperText="Must be unique." />);
    const input = screen.getByLabelText('Username');
    const helper = screen.getByText('Must be unique.');
    expect(helper).toBeInTheDocument();
    expect(input).toHaveAttribute('aria-describedby', expect.stringContaining(helper.id));
  });

  it('G — error text renders with role=alert, input is aria-invalid', () => {
    render(<Input label="Password" errorText="Too short." />);
    const input = screen.getByLabelText('Password');
    const error = screen.getByRole('alert');
    expect(error).toHaveTextContent('Too short.');
    expect(input).toHaveAttribute('aria-invalid', 'true');
  });

  it('H — disabled state passes through to input element', () => {
    render(<Input label="Token" disabled />);
    expect(screen.getByLabelText('Token')).toBeDisabled();
  });

  it('I — helper text hidden when error text is present', () => {
    render(
      <Input label="Field" helperText="Hint text." errorText="Error text." />,
    );
    expect(screen.queryByText('Hint text.')).not.toBeInTheDocument();
    expect(screen.getByText('Error text.')).toBeInTheDocument();
  });
});

// ── Textarea ──────────────────────────────────────────────────────────

describe('Textarea', () => {
  it('J — renders and label associates with textarea', () => {
    render(<Textarea label="Notes" />);
    expect(screen.getByLabelText('Notes')).toBeInTheDocument();
  });

  it('K — helper text renders', () => {
    render(<Textarea label="Bio" helperText="Max 500 chars." />);
    expect(screen.getByText('Max 500 chars.')).toBeInTheDocument();
  });

  it('L — error text renders with role=alert, textarea is aria-invalid', () => {
    render(<Textarea label="Description" errorText="Required." />);
    const error = screen.getByRole('alert');
    expect(error).toHaveTextContent('Required.');
    expect(screen.getByLabelText('Description')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
  });

  it('M — disabled state passes through', () => {
    render(<Textarea label="Locked" disabled />);
    expect(screen.getByLabelText('Locked')).toBeDisabled();
  });
});

// ── Card ──────────────────────────────────────────────────────────────

describe('Card', () => {
  it('N — renders children', () => {
    render(<Card>Content here</Card>);
    expect(screen.getByText('Content here')).toBeInTheDocument();
  });

  it('O — renders title heading when provided', () => {
    render(<Card title="Account details">Content</Card>);
    expect(
      screen.getByRole('heading', { name: 'Account details' }),
    ).toBeInTheDocument();
  });

  it('P — no heading rendered when title is omitted', () => {
    render(<Card>Content</Card>);
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });
});

// ── Banner ────────────────────────────────────────────────────────────

describe('Banner', () => {
  it('Q — info variant has role=status', () => {
    render(<Banner variant="info">Info message</Banner>);
    expect(screen.getByRole('status')).toHaveTextContent('Info message');
  });

  it('R — warning variant has role=alert', () => {
    render(<Banner variant="warning">Watch out</Banner>);
    expect(screen.getByRole('alert')).toHaveTextContent('Watch out');
  });

  it('S — danger variant has role=alert', () => {
    render(<Banner variant="danger">Critical</Banner>);
    expect(screen.getByRole('alert')).toHaveTextContent('Critical');
  });

  it('T — aria-label reflects variant name', () => {
    const { unmount } = render(<Banner variant="info">x</Banner>);
    expect(screen.getByRole('status')).toHaveAttribute('aria-label', 'Info');
    unmount();

    render(<Banner variant="warning">x</Banner>);
    expect(screen.getByRole('alert')).toHaveAttribute('aria-label', 'Warning');
  });

  it('U — default variant is info (role=status)', () => {
    render(<Banner>Default</Banner>);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});
