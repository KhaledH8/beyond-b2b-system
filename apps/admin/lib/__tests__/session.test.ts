import { describe, expect, it, vi } from 'vitest';
import type { SessionData } from '@auth0/nextjs-auth0/types';
import {
  NotOperatorError,
  SessionApiError,
  UnauthorizedError,
  requireOperatorSession,
  type MeImpersonationBlock,
  type MeResponse,
  type RequireOperatorSessionOverrides,
} from '../session';

/**
 * ADR-029 step 2 — session helper unit tests.
 *
 * Every branch of `requireOperatorSession()` is exercised through
 * the override-injection seam. The real Auth0 SDK and the real
 * `fetch` are never invoked: tests construct `vi.fn()` overrides
 * and assert observable behaviour (errors thrown, args passed,
 * `cache: 'no-store'` set, returned identity shape).
 *
 * The session helper itself imports `'server-only'`, which is a
 * no-op at vitest time but is exercised by Next.js at build time.
 * That guard is verified separately in CI by `pnpm --filter
 * @bb/admin build`.
 */

const VALID_API = 'http://localhost:3000';
const VALID_TOKEN = 'access.token.value';

const VALID_ME: MeResponse = {
  auth0Sub: 'auth0|operator-1',
  userId: '01ARZ3NDEKTSV4RRFFQ69G5OPE',
  tenantId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  accountId: null,
  userClass: 'OPERATOR',
};

function makeSession(overrides: Partial<SessionData['user']> = {}): SessionData {
  return {
    user: {
      sub: 'auth0|operator-1',
      email: 'op@beyondborders.test',
      name: 'Op Person',
      ...overrides,
    },
    tokenSet: {
      accessToken: VALID_TOKEN,
      audience: 'https://api.test',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    } as SessionData['tokenSet'],
    internal: { sid: 'sid-1', createdAt: Date.now() },
  } as SessionData;
}

interface MakeFetchOpts {
  status?: number;
  body?: unknown;
  throws?: Error;
}

function makeFetch(opts: MakeFetchOpts = { status: 200, body: VALID_ME }): {
  fn: ReturnType<typeof vi.fn>;
  spy: ReturnType<typeof vi.fn>;
} {
  const fn = vi.fn(async (_url: string, init?: RequestInit) => {
    if (opts.throws) throw opts.throws;
    return new Response(JSON.stringify(opts.body ?? VALID_ME), {
      status: opts.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
    // The vi.fn wrapper preserves init for assertions in the test.
    void init;
  });
  return { fn, spy: fn };
}

function defaultOverrides(
  partial: Partial<RequireOperatorSessionOverrides> = {},
): RequireOperatorSessionOverrides {
  return {
    getSession: vi.fn(async () => makeSession()),
    getAccessToken: vi.fn(async () => VALID_TOKEN),
    fetch: makeFetch().fn as unknown as typeof fetch,
    apiBaseUrl: VALID_API,
    ...partial,
  };
}

// ── Happy path ────────────────────────────────────────────────────────

describe('requireOperatorSession — happy path', () => {
  it('A — returns OperatorIdentity for a valid OPERATOR session', async () => {
    const id = await requireOperatorSession(defaultOverrides());
    expect(id.userId).toBe(VALID_ME.userId);
    expect(id.auth0Sub).toBe(VALID_ME.auth0Sub);
    expect(id.tenantId).toBe(VALID_ME.tenantId);
    expect(id.email).toBe('op@beyondborders.test');
    expect(id.displayName).toBe('Op Person');
    expect(id.roles).toBeUndefined();
  });

  it('B — propagates roles array from /me when present', async () => {
    const meWithRoles: MeResponse = {
      ...VALID_ME,
      roles: ['platform_admin', 'ops_support'],
    };
    const id = await requireOperatorSession(
      defaultOverrides({
        fetch: makeFetch({ status: 200, body: meWithRoles })
          .fn as unknown as typeof fetch,
      }),
    );
    expect(id.roles).toEqual(['platform_admin', 'ops_support']);
  });
});

// ── Session rejection ─────────────────────────────────────────────────

describe('requireOperatorSession — no session', () => {
  it('C — throws UnauthorizedError when getSession returns null', async () => {
    await expect(
      requireOperatorSession(
        defaultOverrides({ getSession: vi.fn(async () => null) }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });
});

// ── Token rejection ────────────────────────────────────────────────────

describe('requireOperatorSession — token problems', () => {
  it('D — throws UnauthorizedError when getAccessToken throws', async () => {
    await expect(
      requireOperatorSession(
        defaultOverrides({
          getAccessToken: vi.fn(async () => {
            throw new Error('SDK token error');
          }),
        }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('E — throws UnauthorizedError when getAccessToken returns empty', async () => {
    await expect(
      requireOperatorSession(
        defaultOverrides({ getAccessToken: vi.fn(async () => '') }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('F — throws UnauthorizedError when getAccessToken returns whitespace', async () => {
    await expect(
      requireOperatorSession(
        defaultOverrides({ getAccessToken: vi.fn(async () => '   ') }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });
});

// ── /me network failure ───────────────────────────────────────────────

describe('requireOperatorSession — /me network failure', () => {
  it('G — throws SessionApiError when fetch throws', async () => {
    await expect(
      requireOperatorSession(
        defaultOverrides({
          fetch: makeFetch({ throws: new Error('ECONNREFUSED') })
            .fn as unknown as typeof fetch,
        }),
      ),
    ).rejects.toBeInstanceOf(SessionApiError);
  });
});

// ── /me 401 / 403 ─────────────────────────────────────────────────────

describe('requireOperatorSession — /me auth failure', () => {
  it('H — throws UnauthorizedError on /me 401', async () => {
    await expect(
      requireOperatorSession(
        defaultOverrides({
          fetch: makeFetch({ status: 401 }).fn as unknown as typeof fetch,
        }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('I — throws UnauthorizedError on /me 403', async () => {
    await expect(
      requireOperatorSession(
        defaultOverrides({
          fetch: makeFetch({ status: 403 }).fn as unknown as typeof fetch,
        }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });
});

// ── /me 5xx ───────────────────────────────────────────────────────────

describe('requireOperatorSession — /me server error', () => {
  it('J — throws SessionApiError on /me 500 with status', async () => {
    try {
      await requireOperatorSession(
        defaultOverrides({
          fetch: makeFetch({ status: 500 }).fn as unknown as typeof fetch,
        }),
      );
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SessionApiError);
      expect((err as SessionApiError).status).toBe(500);
    }
  });

  it('K — throws SessionApiError on invalid JSON in 2xx', async () => {
    const fn = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response('{ not json', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    await expect(
      requireOperatorSession(
        defaultOverrides({ fetch: fn as unknown as typeof fetch }),
      ),
    ).rejects.toBeInstanceOf(SessionApiError);
  });
});

// ── userClass rejection ───────────────────────────────────────────────

describe('requireOperatorSession — class rejection', () => {
  it('L — rejects AGENCY user with NotOperatorError', async () => {
    const agencyMe: MeResponse = { ...VALID_ME, userClass: 'AGENCY', accountId: '01ARZ3NDEKTSV4RRFFQ69G5ACC' };
    await expect(
      requireOperatorSession(
        defaultOverrides({
          fetch: makeFetch({ status: 200, body: agencyMe })
            .fn as unknown as typeof fetch,
        }),
      ),
    ).rejects.toBeInstanceOf(NotOperatorError);
  });

  it('M — rejects OPERATOR with empty roles array (no active role)', async () => {
    const noRoleMe: MeResponse = { ...VALID_ME, roles: [] };
    await expect(
      requireOperatorSession(
        defaultOverrides({
          fetch: makeFetch({ status: 200, body: noRoleMe })
            .fn as unknown as typeof fetch,
        }),
      ),
    ).rejects.toBeInstanceOf(NotOperatorError);
  });
});

// ── cache: 'no-store' enforcement ─────────────────────────────────────

describe('requireOperatorSession — request shape', () => {
  it('N — calls /me with cache: "no-store"', async () => {
    const fn = makeFetch().fn;
    await requireOperatorSession(
      defaultOverrides({ fetch: fn as unknown as typeof fetch }),
    );
    expect(fn).toHaveBeenCalledTimes(1);
    const init = fn.mock.calls[0]![1] as RequestInit;
    expect(init.cache).toBe('no-store');
  });

  it('O — attaches Authorization: Bearer <token> on /me', async () => {
    const fn = makeFetch().fn;
    await requireOperatorSession(
      defaultOverrides({ fetch: fn as unknown as typeof fetch }),
    );
    const init = fn.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${VALID_TOKEN}`);
  });

  it('P — calls the configured BB_API_BASE_URL + /me', async () => {
    const fn = makeFetch().fn;
    await requireOperatorSession(
      defaultOverrides({
        fetch: fn as unknown as typeof fetch,
        apiBaseUrl: 'https://api.example.test',
      }),
    );
    expect(fn).toHaveBeenCalledWith(
      'https://api.example.test/me',
      expect.any(Object),
    );
  });
});

// ── ADR-029 D4 amendment: impersonation carve-out ─────────────────────

describe('requireOperatorSession — impersonation carve-out (ADR-029 D4 amendment)', () => {
  const VALID_IMPERSONATION: MeImpersonationBlock = {
    grantId: '01ARZ3NDEKTSV4RRFFQ69G5GRA',
    actorUserId: VALID_ME.userId,
    actorAuth0Sub: VALID_ME.auth0Sub,
    actorUserClass: 'OPERATOR',
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    scope: 'READ_ONLY',
  };

  function makeImpersonatingMe(
    impersonation: unknown = VALID_IMPERSONATION,
  ): MeResponse {
    return {
      ...VALID_ME,
      userClass: 'AGENCY',
      accountId: '01ARZ3NDEKTSV4RRFFQ69G5TGT',
      impersonation: impersonation as MeImpersonationBlock | undefined,
    };
  }

  it('S — accepts AGENCY-shaped /me with valid OPERATOR impersonation block', async () => {
    const id = await requireOperatorSession(
      defaultOverrides({
        fetch: makeFetch({ status: 200, body: makeImpersonatingMe() })
          .fn as unknown as typeof fetch,
      }),
    );
    expect(id.userId).toBe(VALID_ME.userId);
    expect(id.impersonation).toEqual({
      grantId: VALID_IMPERSONATION.grantId,
      expiresAt: VALID_IMPERSONATION.expiresAt,
      scope: 'READ_ONLY',
    });
  });

  it('T — OperatorIdentity.impersonation is undefined for normal OPERATOR', async () => {
    const id = await requireOperatorSession(defaultOverrides());
    expect(id.impersonation).toBeUndefined();
  });

  it('U — rejects AGENCY-shaped /me with NO impersonation block', async () => {
    await expect(
      requireOperatorSession(
        defaultOverrides({
          fetch: makeFetch({
            status: 200,
            body: { ...VALID_ME, userClass: 'AGENCY', accountId: '01ARZ3NDEKTSV4RRFFQ69G5ACC' },
          }).fn as unknown as typeof fetch,
        }),
      ),
    ).rejects.toBeInstanceOf(NotOperatorError);
  });

  it('V — rejects AGENCY with impersonation.actorUserClass="AGENCY" (not OPERATOR)', async () => {
    const tampered = { ...VALID_IMPERSONATION, actorUserClass: 'AGENCY' };
    await expect(
      requireOperatorSession(
        defaultOverrides({
          fetch: makeFetch({ status: 200, body: makeImpersonatingMe(tampered) })
            .fn as unknown as typeof fetch,
        }),
      ),
    ).rejects.toBeInstanceOf(NotOperatorError);
  });

  it('W — rejects AGENCY with impersonation block missing grantId', async () => {
    const malformed = { ...VALID_IMPERSONATION, grantId: '' };
    await expect(
      requireOperatorSession(
        defaultOverrides({
          fetch: makeFetch({ status: 200, body: makeImpersonatingMe(malformed) })
            .fn as unknown as typeof fetch,
        }),
      ),
    ).rejects.toBeInstanceOf(NotOperatorError);
  });

  it('X — rejects AGENCY with impersonation.scope!="READ_ONLY"', async () => {
    const tampered = { ...VALID_IMPERSONATION, scope: 'READ_WRITE' };
    await expect(
      requireOperatorSession(
        defaultOverrides({
          fetch: makeFetch({ status: 200, body: makeImpersonatingMe(tampered) })
            .fn as unknown as typeof fetch,
        }),
      ),
    ).rejects.toBeInstanceOf(NotOperatorError);
  });

  it('Y — rejects AGENCY when impersonation is a non-object (string)', async () => {
    await expect(
      requireOperatorSession(
        defaultOverrides({
          fetch: makeFetch({ status: 200, body: makeImpersonatingMe('not-an-object') })
            .fn as unknown as typeof fetch,
        }),
      ),
    ).rejects.toBeInstanceOf(NotOperatorError);
  });

  it('Z — rejects AGENCY when impersonation is an array', async () => {
    await expect(
      requireOperatorSession(
        defaultOverrides({
          fetch: makeFetch({ status: 200, body: makeImpersonatingMe([VALID_IMPERSONATION]) })
            .fn as unknown as typeof fetch,
        }),
      ),
    ).rejects.toBeInstanceOf(NotOperatorError);
  });

  it('AA — does not return access token or full session in OperatorIdentity', async () => {
    const id = await requireOperatorSession(
      defaultOverrides({
        fetch: makeFetch({ status: 200, body: makeImpersonatingMe() })
          .fn as unknown as typeof fetch,
      }),
    );
    // Defense-in-depth: enumerate keys to confirm no token / session leakage.
    const keys = Object.keys(id);
    expect(keys).not.toContain('accessToken');
    expect(keys).not.toContain('session');
    expect(keys).not.toContain('tokenSet');
  });
});

// ── token-exposure guard (server-only) ────────────────────────────────

describe('session module — server-only guard', () => {
  it('Q — session.ts top-line includes the server-only import', async () => {
    // Read the module source from disk to confirm the guard is in place.
    // This is a static smoke check; the runtime enforcement happens at
    // Next build time when a client component imports the module.
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const url = await import('node:url');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const src = await fs.readFile(path.join(here, '..', 'session.ts'), 'utf8');
    expect(src.startsWith("import 'server-only';")).toBe(true);
  });

  it('R — auth0.ts top-line includes the server-only import', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const url = await import('node:url');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const src = await fs.readFile(path.join(here, '..', 'auth0.ts'), 'utf8');
    expect(src.startsWith("import 'server-only';")).toBe(true);
  });
});
