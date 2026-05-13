import { describe, expect, it, vi } from 'vitest';

/**
 * ADR-027 Slice 3 — impersonation-client tests.
 *
 * `impersonation-client.ts` is a thin typed wrapper over `apiFetch`.
 * It does NOT inject its own test seam — every public function
 * eventually calls `apiFetch` with a fixed (method, path, body)
 * triple. To test that wiring without spinning up an HTTP server, we
 * mock the `api-client` module and assert what arguments arrive at
 * `apiFetch`. Response shape parsing is exercised by routing fake
 * return values back through the public function.
 */

vi.mock('../api-client', () => ({
  apiFetch: vi.fn(),
  // Stubs so type-only re-exports don't blow up if anything imports them.
  ApiError: class {},
  ApiUnauthorizedError: class {},
  ApiForbiddenError: class {},
  ApiNotFoundError: class {},
  ApiConflictError: class {},
  ApiValidationError: class {},
  ApiServerError: class {},
  ApiNetworkError: class {},
}));

import { apiFetch } from '../api-client';
import {
  getActiveImpersonation,
  startImpersonation,
  stopImpersonation,
  type ActiveImpersonationResponse,
  type StartImpersonationResponse,
} from '../impersonation-client';

const TENANT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const TARGET_ID = '01ARZ3NDEKTSV4RRFFQ69G5TGT';
const GRANT_ID = '01ARZ3NDEKTSV4RRFFQ69G5GRA';
const ACTOR_ID = '01ARZ3NDEKTSV4RRFFQ69G5OPE';

const ACTIVE_FIXTURE: ActiveImpersonationResponse = {
  grant: {
    id: GRANT_ID,
    tenantId: TENANT_ID,
    actorUserId: ACTOR_ID,
    targetAccountId: TARGET_ID,
    reasonText: 'Investigating ticket SUP-1',
    ticketRef: 'SUP-1',
    scope: 'READ_ONLY',
    startedAt: '2026-05-10T10:00:00.000Z',
    expiresAt: '2026-05-10T10:30:00.000Z',
    endedAt: null,
    endedReason: null,
    ipAddress: null,
    userAgent: null,
  },
  target: {
    accountId: TARGET_ID,
    accountName: 'Acme Travel',
  },
};

const START_FIXTURE: StartImpersonationResponse = {
  grantId: GRANT_ID,
  expiresAt: '2026-05-10T10:30:00.000Z',
  target: {
    accountId: TARGET_ID,
    accountName: 'Acme Travel',
  },
};

// ── getActiveImpersonation ────────────────────────────────────────────

describe('getActiveImpersonation', () => {
  it('A — calls GET /impersonation/active and returns the parsed response', async () => {
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ACTIVE_FIXTURE);

    const result = await getActiveImpersonation();

    expect(apiFetch).toHaveBeenCalledWith('GET', '/impersonation/active');
    expect(result).toEqual(ACTIVE_FIXTURE);
    expect(result?.grant.id).toBe(GRANT_ID);
    expect(result?.target.accountName).toBe('Acme Travel');
  });

  it('B — returns null when the backend returns null', async () => {
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    expect(await getActiveImpersonation()).toBeNull();
  });

  it('C — normalizes undefined to null (defense against empty 2xx body)', async () => {
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    expect(await getActiveImpersonation()).toBeNull();
  });
});

// ── startImpersonation ────────────────────────────────────────────────

describe('startImpersonation', () => {
  it('D — calls POST /impersonation/start with the exact input body', async () => {
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(START_FIXTURE);

    const result = await startImpersonation({
      targetAccountId: TARGET_ID,
      reasonText: 'Investigating ticket SUP-1',
      ticketRef: 'SUP-1',
    });

    expect(apiFetch).toHaveBeenCalledWith('POST', '/impersonation/start', {
      body: {
        targetAccountId: TARGET_ID,
        reasonText: 'Investigating ticket SUP-1',
        ticketRef: 'SUP-1',
      },
    });
    expect(result.grantId).toBe(GRANT_ID);
    expect(result.target.accountName).toBe('Acme Travel');
  });

  it('E — propagates errors thrown by apiFetch (typed error hierarchy)', async () => {
    const err = new Error('forbidden');
    (apiFetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(err);
    await expect(
      startImpersonation({
        targetAccountId: TARGET_ID,
        reasonText: 'x',
        ticketRef: 'SUP-1',
      }),
    ).rejects.toBe(err);
  });
});

// ── stopImpersonation ─────────────────────────────────────────────────

describe('stopImpersonation', () => {
  it('F — calls POST /impersonation/stop with an empty object body', async () => {
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ended: true });

    const result = await stopImpersonation();

    expect(apiFetch).toHaveBeenCalledWith('POST', '/impersonation/stop', {
      body: {},
    });
    expect(result.ended).toBe(true);
  });

  it('G — returns ended=false when no grant was active (idempotent)', async () => {
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ended: false });
    expect((await stopImpersonation()).ended).toBe(false);
  });
});
