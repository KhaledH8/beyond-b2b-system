import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ADR-029 step 4 — protected route-group layout tests.
 *
 * The layout is an async server component. It depends on:
 *
 *   - `requireOperatorSession()` from `lib/session`
 *   - `redirect()` from `next/navigation`
 *
 * Both are module-mocked. `redirect` is wired to throw a sentinel
 * error so the layout's `redirect(...)` call exits the function
 * (matching production semantics where Next's real `redirect`
 * throws). Tests assert which destination was passed.
 *
 * The layout's `instanceof` checks depend on the same Error class
 * identities the test throws, so the mock factory exposes the
 * classes and the test imports them from the (mocked) module.
 */

// vi.hoisted runs before module loads; required so vi.mock factories
// (which are also hoisted) can read this state.
const sessionState = vi.hoisted(() => ({
  result: undefined as unknown,
  shouldThrow: undefined as unknown,
}));

class RedirectSentinel extends Error {
  destination: string;
  constructor(dest: string) {
    super(`Redirect:${dest}`);
    this.name = 'RedirectSentinel';
    this.destination = dest;
  }
}

vi.mock('next/navigation', () => ({
  redirect: vi.fn((dest: string) => {
    throw new RedirectSentinel(dest);
  }),
}));

vi.mock('../../lib/session', () => {
  class UnauthorizedError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'UnauthorizedError';
    }
  }
  class NotOperatorError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'NotOperatorError';
    }
  }
  class SessionApiError extends Error {
    readonly status?: number;
    constructor(message: string, status?: number) {
      super(message);
      this.name = 'SessionApiError';
      this.status = status;
    }
  }
  return {
    UnauthorizedError,
    NotOperatorError,
    SessionApiError,
    requireOperatorSession: vi.fn(async () => {
      if (sessionState.shouldThrow) throw sessionState.shouldThrow;
      return sessionState.result;
    }),
  };
});

// Imports must come AFTER vi.mock declarations.
import ProtectedLayout, {
  dynamic,
  revalidate,
} from '../(protected)/layout';
import { redirect } from 'next/navigation';
import {
  NotOperatorError,
  SessionApiError,
  UnauthorizedError,
} from '../../lib/session';

const VALID_IDENTITY = {
  userId: '01ARZ3NDEKTSV4RRFFQ69G5OPE',
  auth0Sub: 'auth0|operator',
  tenantId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  email: 'op@beyondborders.test',
  displayName: 'Op Person',
  roles: undefined,
};

// ── Module-level export checks (ADR-029 D6 dynamic rules) ─────────────

describe('ProtectedLayout — module exports', () => {
  it('A — exports dynamic = "force-dynamic"', () => {
    expect(dynamic).toBe('force-dynamic');
  });

  it('B — exports revalidate = 0', () => {
    expect(revalidate).toBe(0);
  });
});

// ── Gate behavior ─────────────────────────────────────────────────────

describe('ProtectedLayout — gate behavior', () => {
  beforeEach(() => {
    sessionState.result = VALID_IDENTITY;
    sessionState.shouldThrow = undefined;
    (redirect as unknown as ReturnType<typeof vi.fn>).mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('C — renders children when requireOperatorSession resolves', async () => {
    const result = await ProtectedLayout({ children: 'test-children' });
    // Result is a JSX fragment carrying the children. We don't try
    // to render it — the assertion is structural.
    expect(result).toBeDefined();
    expect(redirect).not.toHaveBeenCalled();
  });

  it('D — redirects to /auth/login on UnauthorizedError', async () => {
    sessionState.shouldThrow = new UnauthorizedError('no active session');
    await expect(
      ProtectedLayout({ children: null }),
    ).rejects.toBeInstanceOf(RedirectSentinel);
    expect(redirect).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledWith('/auth/login');
  });

  it('E — redirects to /not-operator on NotOperatorError', async () => {
    sessionState.shouldThrow = new NotOperatorError('agency user');
    await expect(
      ProtectedLayout({ children: null }),
    ).rejects.toBeInstanceOf(RedirectSentinel);
    expect(redirect).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledWith('/not-operator');
  });

  it('F — rethrows SessionApiError without redirecting', async () => {
    sessionState.shouldThrow = new SessionApiError('500 from /me', 500);
    await expect(
      ProtectedLayout({ children: null }),
    ).rejects.toBeInstanceOf(SessionApiError);
    expect(redirect).not.toHaveBeenCalled();
  });

  it('G — rethrows unexpected errors without redirecting', async () => {
    const err = new Error('unexpected');
    sessionState.shouldThrow = err;
    await expect(ProtectedLayout({ children: null })).rejects.toBe(err);
    expect(redirect).not.toHaveBeenCalled();
  });

  it('H — calls requireOperatorSession with no arguments (server-side context)', async () => {
    const sessionModule = await import('../../lib/session');
    const fn = sessionModule.requireOperatorSession as unknown as ReturnType<
      typeof vi.fn
    >;
    fn.mockClear();
    await ProtectedLayout({ children: null });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith();
  });
});
