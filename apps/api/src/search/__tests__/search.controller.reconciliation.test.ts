import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { SearchResponse } from '@bb/domain';
import { SearchController } from '../search.controller';
import type { SearchService } from '../search.service';
import type { AuthContext } from '../../auth/auth-context';

/**
 * Pure unit tests for the body-reconciliation logic added in
 * ADR-026 Slice E4-B. The guard pipeline is exercised in
 * `search.controller.guards.test.ts`; this file targets the
 * controller method directly so the reconciliation rules can be
 * pinned without booting Nest.
 *
 * Locked rules (V1):
 *
 *   - AGENCY user, body matches AuthContext   → SearchService called
 *     with AuthContext-derived tenantId/accountId.
 *   - AGENCY user, body.tenantId mismatches   → 403, no service call.
 *   - AGENCY user, body.accountId mismatches  → 403, no service call.
 *   - AGENCY user, body omits tenantId        → derived from
 *     AuthContext, 200.
 *   - AGENCY user, body omits accountId       → derived from
 *     AuthContext, 200.
 *   - OPERATOR user (any role, including a hypothetical
 *     platform_admin that holds SEARCH_EXECUTE)
 *                                              → 403 with policy
 *     message, no service call.
 *   - AGENCY user with empty AuthContext.accountId
 *     (defense-in-depth)                       → 403, no service call.
 *
 * The body-shape validator (`parseSearchBody`) raises
 * `BadRequestException` for malformed input — that path is unchanged
 * from E4-A and is verified in one anchor test below.
 */

const TENANT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const ACCOUNT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAC';
const OTHER_TENANT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
const OTHER_ACCOUNT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAD';
const USER_ID = '01ARZ3NDEKTSV4RRFFQ69G5USR';

function makeAgencyAuth(over: Partial<AuthContext> = {}): AuthContext {
  return {
    auth0Sub: 'auth0|agent',
    userId: USER_ID,
    tenantId: TENANT_ID,
    accountId: ACCOUNT_ID,
    userClass: 'AGENCY',
    ...over,
  };
}

function makeOperatorAuth(over: Partial<AuthContext> = {}): AuthContext {
  return {
    auth0Sub: 'auth0|ops',
    userId: USER_ID,
    tenantId: TENANT_ID,
    accountId: null,
    userClass: 'OPERATOR',
    ...over,
  };
}

function emptyResponse(): SearchResponse {
  return {
    meta: {
      searchId: '01ARZ3NDEKTSV4RRFFQ69G5SCH',
      generatedAt: new Date().toISOString(),
      currency: 'EUR',
      currencies: ['EUR'],
      resultCount: 0,
      accountContext: {
        accountType: 'AGENCY',
        tenantId: TENANT_ID,
        accountId: ACCOUNT_ID,
      },
    },
    results: [],
  };
}

function makeService(): {
  service: SearchService;
  search: ReturnType<typeof vi.fn>;
} {
  const search = vi.fn(async () => emptyResponse());
  return { service: { search } as unknown as SearchService, search };
}

function validBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tenantId: TENANT_ID,
    accountId: ACCOUNT_ID,
    supplierHotelIds: ['1000073'],
    checkIn: '2026-06-01',
    checkOut: '2026-06-03',
    occupancy: { adults: 2, children: 0 },
    currency: 'EUR',
    ...over,
  };
}

describe('SearchController.search — AGENCY reconciliation', () => {
  it('passes through when body tenantId+accountId match AuthContext', async () => {
    const { service, search } = makeService();
    const ctl = new SearchController(service);
    await ctl.search(validBody(), makeAgencyAuth());
    expect(search).toHaveBeenCalledTimes(1);
    const req = search.mock.calls[0]![0];
    expect(req.tenantId).toBe(TENANT_ID);
    expect(req.accountId).toBe(ACCOUNT_ID);
    expect(req.supplierHotelIds).toEqual(['1000073']);
  });

  it('derives tenantId from AuthContext when body omits it', async () => {
    const { service, search } = makeService();
    const ctl = new SearchController(service);
    const body = validBody();
    delete body['tenantId'];
    await ctl.search(body, makeAgencyAuth());
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0]![0].tenantId).toBe(TENANT_ID);
    expect(search.mock.calls[0]![0].accountId).toBe(ACCOUNT_ID);
  });

  it('derives accountId from AuthContext when body omits it', async () => {
    const { service, search } = makeService();
    const ctl = new SearchController(service);
    const body = validBody();
    delete body['accountId'];
    await ctl.search(body, makeAgencyAuth());
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0]![0].accountId).toBe(ACCOUNT_ID);
  });

  it('derives both when body omits both', async () => {
    const { service, search } = makeService();
    const ctl = new SearchController(service);
    const body = validBody();
    delete body['tenantId'];
    delete body['accountId'];
    await ctl.search(body, makeAgencyAuth());
    const req = search.mock.calls[0]![0];
    expect(req.tenantId).toBe(TENANT_ID);
    expect(req.accountId).toBe(ACCOUNT_ID);
  });

  it('throws Forbidden when body.tenantId disagrees with AuthContext.tenantId', async () => {
    const { service, search } = makeService();
    const ctl = new SearchController(service);
    await expect(
      ctl.search(validBody({ tenantId: OTHER_TENANT_ID }), makeAgencyAuth()),
    ).rejects.toThrow(ForbiddenException);
    expect(search).not.toHaveBeenCalled();
  });

  it('throws Forbidden when body.accountId disagrees with AuthContext.accountId', async () => {
    const { service, search } = makeService();
    const ctl = new SearchController(service);
    await expect(
      ctl.search(validBody({ accountId: OTHER_ACCOUNT_ID }), makeAgencyAuth()),
    ).rejects.toThrow(ForbiddenException);
    expect(search).not.toHaveBeenCalled();
  });

  it('throws Forbidden when both fields disagree (no leak about which one)', async () => {
    const { service, search } = makeService();
    const ctl = new SearchController(service);
    await expect(
      ctl.search(
        validBody({
          tenantId: OTHER_TENANT_ID,
          accountId: OTHER_ACCOUNT_ID,
        }),
        makeAgencyAuth(),
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(search).not.toHaveBeenCalled();
  });

  it('rejects an empty-string accountId in the body as malformed input (400, not 403)', async () => {
    const { service, search } = makeService();
    const ctl = new SearchController(service);
    await expect(
      ctl.search(validBody({ accountId: '' }), makeAgencyAuth()),
    ).rejects.toThrow(BadRequestException);
    expect(search).not.toHaveBeenCalled();
  });

  it('preserves currency / displayCurrency / occupancy from the body', async () => {
    const { service, search } = makeService();
    const ctl = new SearchController(service);
    await ctl.search(
      validBody({
        currency: 'AED',
        displayCurrency: 'USD',
        occupancy: { adults: 2, children: 1, childAges: [4] },
      }),
      makeAgencyAuth(),
    );
    const req = search.mock.calls[0]![0];
    expect(req.currency).toBe('AED');
    expect(req.displayCurrency).toBe('USD');
    expect(req.occupancy).toEqual({ adults: 2, children: 1, childAges: [4] });
  });
});

describe('SearchController.search — OPERATOR is denied as-self in V1', () => {
  it('throws Forbidden with the impersonation policy message for any operator', async () => {
    const { service, search } = makeService();
    const ctl = new SearchController(service);
    try {
      await ctl.search(validBody(), makeOperatorAuth());
      throw new Error('expected ForbiddenException');
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenException);
      // Policy info is intentionally surfaced for OPERATOR — it tells
      // the caller WHY their otherwise-valid token is rejected.
      const message = (err as ForbiddenException).message;
      expect(message).toMatch(/impersonation/i);
      // Message references ADR-027 (the impersonation ADR shipped V1.0
      // 2026-05-09); the older ADR-026 E8 reference was retired with
      // the shipping slice.
      expect(message).toMatch(/ADR-027/);
    }
    expect(search).not.toHaveBeenCalled();
  });

  it('denies even when the body has matching IDs (the gate is the userClass, not body shape)', async () => {
    // An operator without an account_id has no legitimate "matching"
    // body to send. We confirm that even a body that names some
    // other account does not change the outcome.
    const { service, search } = makeService();
    const ctl = new SearchController(service);
    await expect(
      ctl.search(
        validBody({ accountId: OTHER_ACCOUNT_ID }),
        makeOperatorAuth(),
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(search).not.toHaveBeenCalled();
  });
});

describe('SearchController.search — defense in depth', () => {
  it('throws Forbidden when an AGENCY AuthContext has a null accountId', async () => {
    // PermissionResolverService should never produce this state, but
    // a future alternate AuthContext-construction path (impersonation,
    // service-internal calls) could. We fail closed.
    const { service, search } = makeService();
    const ctl = new SearchController(service);
    await expect(
      ctl.search(validBody(), makeAgencyAuth({ accountId: null })),
    ).rejects.toThrow(ForbiddenException);
    expect(search).not.toHaveBeenCalled();
  });

  it('throws Forbidden when an AGENCY AuthContext carries an empty-string accountId', async () => {
    const { service, search } = makeService();
    const ctl = new SearchController(service);
    await expect(
      ctl.search(validBody(), makeAgencyAuth({ accountId: '' })),
    ).rejects.toThrow(ForbiddenException);
    expect(search).not.toHaveBeenCalled();
  });

  it('rejects malformed bodies (missing required fields) with 400, before reconciliation', async () => {
    const { service, search } = makeService();
    const ctl = new SearchController(service);
    // A body with no supplierHotelIds is a body-shape failure, not an
    // auth failure — it should surface as 400.
    const body = validBody();
    delete body['supplierHotelIds'];
    await expect(ctl.search(body, makeAgencyAuth())).rejects.toThrow(
      BadRequestException,
    );
    expect(search).not.toHaveBeenCalled();
  });
});
