import { describe, expect, it } from 'vitest';
import { AdminEnvError, loadAdminEnv } from '../env';

/**
 * ADR-029 step 1 — env validator unit tests.
 *
 * Every required variable has at least:
 *   - one missing / empty case
 *   - one malformed case (where applicable)
 *   - one valid case (covered by the all-valid baseline below)
 *
 * Plus the V0.1-specific scope rules:
 *   - `openid` required
 *   - `offline_access` forbidden (ADR-029 D8)
 *
 * The validator is total: every error path is reachable from outside
 * by passing a single record. No process.env mutation, no global state.
 */

const VALID = Object.freeze({
  AUTH0_SECRET: 'a'.repeat(64),
  APP_BASE_URL: 'http://localhost:3012',
  AUTH0_DOMAIN: 'beyondborders-dev.eu.auth0.com',
  AUTH0_CLIENT_ID: 'client-id-abc',
  AUTH0_CLIENT_SECRET: 'client-secret-xyz',
  AUTH0_AUDIENCE: 'https://api.beyondborders.platform',
  AUTH0_SCOPE: 'openid profile email',
  BB_API_BASE_URL: 'http://localhost:3000',
  BB_TENANT_ID: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
});

function withOverride(overrides: Record<string, string | undefined>): Record<string, string | undefined> {
  return { ...VALID, ...overrides };
}

// ── Happy path ────────────────────────────────────────────────────────

describe('loadAdminEnv — happy path', () => {
  it('returns the full typed shape when every variable is valid', () => {
    const env = loadAdminEnv(VALID);
    expect(env.auth0.secret).toBe(VALID.AUTH0_SECRET);
    expect(env.auth0.appBaseUrl).toBe(VALID.APP_BASE_URL);
    expect(env.auth0.domain).toBe(VALID.AUTH0_DOMAIN);
    expect(env.auth0.clientId).toBe(VALID.AUTH0_CLIENT_ID);
    expect(env.auth0.clientSecret).toBe(VALID.AUTH0_CLIENT_SECRET);
    expect(env.auth0.audience).toBe(VALID.AUTH0_AUDIENCE);
    expect(env.auth0.scope).toBe('openid profile email');
    expect(env.api.baseUrl).toBe(VALID.BB_API_BASE_URL);
    expect(env.tenantId).toBe(VALID.BB_TENANT_ID);
  });

  it('normalises whitespace in AUTH0_SCOPE', () => {
    const env = loadAdminEnv(withOverride({ AUTH0_SCOPE: 'openid   profile  email' }));
    expect(env.auth0.scope).toBe('openid profile email');
  });
});

// ── Required-variable missing / empty ─────────────────────────────────

describe('loadAdminEnv — required variable missing or empty', () => {
  const required = [
    'AUTH0_SECRET',
    'APP_BASE_URL',
    'AUTH0_DOMAIN',
    'AUTH0_CLIENT_ID',
    'AUTH0_CLIENT_SECRET',
    'AUTH0_AUDIENCE',
    'AUTH0_SCOPE',
    'BB_API_BASE_URL',
    'BB_TENANT_ID',
  ] as const;

  for (const name of required) {
    it(`throws AdminEnvError when ${name} is missing`, () => {
      expect(() => loadAdminEnv(withOverride({ [name]: undefined }))).toThrow(
        AdminEnvError,
      );
    });

    it(`throws AdminEnvError when ${name} is empty / whitespace`, () => {
      expect(() => loadAdminEnv(withOverride({ [name]: '   ' }))).toThrow(
        AdminEnvError,
      );
    });
  }
});

// ── URL-shape validation ──────────────────────────────────────────────

describe('loadAdminEnv — URL-shape validation', () => {
  it.each(['APP_BASE_URL', 'AUTH0_AUDIENCE', 'BB_API_BASE_URL'] as const)(
    'rejects malformed URL on %s',
    (name) => {
      expect(() => loadAdminEnv(withOverride({ [name]: 'not a url' }))).toThrow(
        /must be a well-formed URL/,
      );
    },
  );
});

// ── AUTH0_DOMAIN-shape validation ─────────────────────────────────────

describe('loadAdminEnv — AUTH0_DOMAIN shape', () => {
  it('rejects AUTH0_DOMAIN with a scheme', () => {
    expect(() =>
      loadAdminEnv(withOverride({ AUTH0_DOMAIN: 'https://tenant.eu.auth0.com' })),
    ).toThrow(/must be a hostname only, with no scheme/);
  });

  it('rejects AUTH0_DOMAIN with a path', () => {
    expect(() =>
      loadAdminEnv(withOverride({ AUTH0_DOMAIN: 'tenant.eu.auth0.com/foo' })),
    ).toThrow(/must be a hostname only, with no path/);
  });

  it('rejects AUTH0_DOMAIN that is not a fully-qualified domain', () => {
    expect(() =>
      loadAdminEnv(withOverride({ AUTH0_DOMAIN: 'localhost' })),
    ).toThrow(/must be a fully-qualified domain/);
  });
});

// ── AUTH0_SCOPE rules (V0.1) ──────────────────────────────────────────

describe('loadAdminEnv — AUTH0_SCOPE V0.1 rules', () => {
  it('rejects AUTH0_SCOPE that does not include "openid"', () => {
    expect(() =>
      loadAdminEnv(withOverride({ AUTH0_SCOPE: 'profile email' })),
    ).toThrow(/must include the "openid" scope/);
  });

  it('rejects AUTH0_SCOPE that includes "offline_access" (ADR-029 D8)', () => {
    expect(() =>
      loadAdminEnv(
        withOverride({ AUTH0_SCOPE: 'openid profile email offline_access' }),
      ),
    ).toThrow(/must NOT include "offline_access"/);
  });
});

// ── BB_TENANT_ID ULID validation ──────────────────────────────────────

describe('loadAdminEnv — BB_TENANT_ID ULID validation', () => {
  it('rejects a non-ULID BB_TENANT_ID', () => {
    expect(() =>
      loadAdminEnv(withOverride({ BB_TENANT_ID: 'not-a-ulid' })),
    ).toThrow(/Crockford base32 ULID/);
  });

  it('rejects BB_TENANT_ID that is the wrong length', () => {
    expect(() =>
      loadAdminEnv(withOverride({ BB_TENANT_ID: '01ARZ3NDEKTSV4RRFFQ69G5' })), // 23 chars
    ).toThrow(/Crockford base32 ULID/);
  });

  it('rejects BB_TENANT_ID containing forbidden characters (I, L, O, U)', () => {
    // Replace a valid char with 'I' to break Crockford encoding.
    expect(() =>
      loadAdminEnv(withOverride({ BB_TENANT_ID: '01ARZ3NDEKTSV4RRFFIQ69G5FAV' })), // 27 chars deliberately
    ).toThrow(/Crockford base32 ULID/);
  });
});

// ── No fallback defaults ──────────────────────────────────────────────

describe('loadAdminEnv — never silently defaults', () => {
  it('does not fall back when AUTH0_SCOPE is missing', () => {
    expect(() => loadAdminEnv(withOverride({ AUTH0_SCOPE: undefined }))).toThrow(
      AdminEnvError,
    );
  });

  it('does not fall back when BB_TENANT_ID is missing', () => {
    expect(() =>
      loadAdminEnv(withOverride({ BB_TENANT_ID: undefined })),
    ).toThrow(AdminEnvError);
  });
});

// ── Error shape ───────────────────────────────────────────────────────

describe('loadAdminEnv — error shape', () => {
  it('throws AdminEnvError (not generic Error) so callers can narrow', () => {
    try {
      loadAdminEnv(withOverride({ AUTH0_SECRET: '' }));
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AdminEnvError);
      expect((err as AdminEnvError).name).toBe('AdminEnvError');
      expect((err as AdminEnvError).message).toMatch(/AUTH0_SECRET/);
    }
  });
});
