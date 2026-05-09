import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { Module, type INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SearchController } from '../search.controller';
import { SearchService } from '../search.service';
import { JwtAuthGuard } from '../../auth/jwt/jwt-auth.guard';
import { RolesGuard } from '../../auth/permissions/roles.guard';
import { JwtValidatorService } from '../../auth/jwt/jwt-validator.service';
import { JwksCacheService } from '../../auth/jwt/jwks-cache.service';
import { UserSyncService } from '../../auth/user-sync/user-sync.service';
import { PermissionResolverService } from '../../auth/permissions/permission-resolver.service';
import { ImpersonationGrantRepository } from '../../auth/impersonation/impersonation-grant.repository';
import { PG_POOL } from '../../database/database.module';
import { REQUIRE_PERMISSION_KEY } from '../../auth/permissions/require-permission.decorator';
import {
  PERMISSIONS,
  __PERMISSION_MAP_FOR_TESTS,
  type Permission,
} from '../../auth/permissions/permissions';

/**
 * Pattern test for the ADR-026 Slice E4-A endpoint retrofit.
 *
 * Two layers of verification:
 *
 *   A) Reflector-level — pin the controller's metadata so a future
 *      "I'll just remove this @RequirePermission for now" diff fails
 *      noisily instead of silently exposing the route.
 *
 *   B) HTTP-level — boot a real Nest app with the actual JwtAuthGuard
 *      and RolesGuard wired to mocked validator/sync/resolver, then
 *      drive the controller via fetch:
 *        - missing bearer       → 401
 *        - invalid bearer       → 401
 *        - AGENCY w/ permission → 200/201
 *        - AGENCY w/o permission → 403
 *        - OPERATOR (cross-class, no SEARCH_EXECUTE) → 403
 *
 *   Both guards are unmocked — the test exercises the same canActivate
 *   code paths production runs. Only the *boundaries* of the auth
 *   pipeline (JWT verify, user sync, permission resolution) are
 *   mocked, because their inputs (bearer token bytes, DB rows) are
 *   what we'd otherwise need a full stack to fake.
 *
 * If we ever add a second retrofit slice (E4-B etc), copy this file
 * verbatim, swap the controller and required permission, and you have
 * the new pattern test.
 */

const TENANT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const USER_ID = '01ARZ3NDEKTSV4RRFFQ69G5USR';
const ACCOUNT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAC';
const VALID_TOKEN = 'valid.bearer.token';
const INVALID_TOKEN = 'invalid.bearer.token';

// ---------------------------------------------------------------------------
// A) Reflector / metadata assertions
// ---------------------------------------------------------------------------

describe('SearchController retrofit metadata', () => {
  it('declares JwtAuthGuard and RolesGuard at the controller level, in that order', () => {
    // NestJS stores guards under the '__guards__' Reflect metadata key
    // when @UseGuards is applied. The order matters: JwtAuthGuard must
    // run before RolesGuard so AuthContext is populated for the latter.
    const guards = Reflect.getMetadata('__guards__', SearchController) as
      | unknown[]
      | undefined;
    expect(guards).toBeDefined();
    expect(guards).toHaveLength(2);
    expect(guards![0]).toBe(JwtAuthGuard);
    expect(guards![1]).toBe(RolesGuard);
  });

  it('declares @RequirePermission(SEARCH_EXECUTE) on the search method', () => {
    const reflector = new Reflector();
    const meta = reflector.get<readonly Permission[]>(
      REQUIRE_PERMISSION_KEY,
      SearchController.prototype.search,
    );
    expect(meta).toEqual([PERMISSIONS.SEARCH_EXECUTE]);
  });

  it('SEARCH_EXECUTE is held by every agency role and by no non-platform_admin operator role', () => {
    // Role-shape sanity check. If a future ADR-026 amendment adds
    // SEARCH_EXECUTE to (say) read_only_auditor, this test must be
    // updated *deliberately* — it's a guard against accidental grants.
    for (const role of ['account_admin', 'booker', 'finance'] as const) {
      expect(
        __PERMISSION_MAP_FOR_TESTS.agency[role].has(PERMISSIONS.SEARCH_EXECUTE),
      ).toBe(true);
    }
    for (const role of [
      'ops_support',
      'finance_ops',
      'integrations_ops',
      'read_only_auditor',
    ] as const) {
      expect(
        __PERMISSION_MAP_FOR_TESTS.operator[role].has(PERMISSIONS.SEARCH_EXECUTE),
      ).toBe(false);
    }
    // platform_admin holds every permission by definition (locked
    // ADR-026 D8 rule), so it's exempt from this assertion.
    expect(
      __PERMISSION_MAP_FOR_TESTS.operator.platform_admin.has(
        PERMISSIONS.SEARCH_EXECUTE,
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// B) HTTP-level guard exercise via a real Nest app
// ---------------------------------------------------------------------------

interface AuthFakeState {
  validResponse:
    | {
        auth0Sub: string;
        tenantId: string;
        userClass: 'OPERATOR' | 'AGENCY';
        accountId: string | null;
        exp: number;
      }
    | null;
  syncedUser:
    | {
        id: string;
        tenantId: string;
        userClass: 'OPERATOR' | 'AGENCY';
        // The rest of CoreUserRecord fields aren't read by the guard.
      }
    | null;
  resolvedPermissions: Set<Permission>;
  resolvedAccountId: string | null;
}

const fakeState: AuthFakeState = {
  validResponse: null,
  syncedUser: null,
  resolvedPermissions: new Set(),
  resolvedAccountId: null,
};

const fakeValidator = {
  validate: vi.fn(async (token: string) => {
    if (token === VALID_TOKEN && fakeState.validResponse) {
      return fakeState.validResponse;
    }
    // JwtAuthGuard logs and 401s on InvalidJwtError. Mirror that.
    const { InvalidJwtError } = await import(
      '../../auth/jwt/jwt-validator.service'
    );
    throw new InvalidJwtError('test rejection');
  }),
};

const fakeUserSync = {
  syncOnAuthentication: vi.fn(async () => {
    if (!fakeState.syncedUser) {
      const { MissingUserError } = await import(
        '../../auth/user-sync/user-sync.service'
      );
      throw new MissingUserError('test|missing');
    }
    return fakeState.syncedUser;
  }),
};

const fakeResolver = {
  resolve: vi.fn(async (auth) => ({
    userId: auth.userId,
    userClass: auth.userClass,
    roles: [],
    permissions: fakeState.resolvedPermissions,
    accountId: fakeState.resolvedAccountId,
  })),
  hasPermission: vi.fn(),
};

const fakeJwks = { getKey: vi.fn() };

const fakeSearchService = {
  search: vi.fn(async () => ({
    meta: {
      tenantId: TENANT_ID,
      accountId: ACCOUNT_ID,
      currency: 'EUR',
      currencies: ['EUR'],
      accountContext: { accountType: 'AGENCY', tenantId: TENANT_ID },
    },
    results: [],
  })),
};

@Module({
  controllers: [SearchController],
  providers: [
    Reflector,
    { provide: SearchService, useValue: fakeSearchService },
    { provide: JwtValidatorService, useValue: fakeValidator },
    { provide: JwksCacheService, useValue: fakeJwks },
    { provide: UserSyncService, useValue: fakeUserSync },
    { provide: PermissionResolverService, useValue: fakeResolver },
    { provide: ImpersonationGrantRepository, useValue: { findActiveByActor: vi.fn(async () => null) } },
    { provide: PG_POOL, useValue: {} },
    JwtAuthGuard,
    RolesGuard,
  ],
})
class GuardTestModule {}

describe('SearchController guard pipeline (HTTP)', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [GuardTestModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    const server = app.getHttpServer() as {
      listening: boolean;
      listen: (port: number, cb: () => void) => unknown;
      address: () => { port: number };
    };
    if (!server.listening) {
      await new Promise<void>((resolve) =>
        server.listen(0, () => resolve()),
      );
    }
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  function resetFakes(): void {
    fakeState.validResponse = null;
    fakeState.syncedUser = null;
    fakeState.resolvedPermissions = new Set();
    fakeState.resolvedAccountId = null;
    fakeValidator.validate.mockClear();
    fakeUserSync.syncOnAuthentication.mockClear();
    fakeResolver.resolve.mockClear();
    fakeSearchService.search.mockClear();
  }

  function configureValidAgencyToken(perms: readonly Permission[]): void {
    fakeState.validResponse = {
      auth0Sub: 'auth0|agent',
      tenantId: TENANT_ID,
      userClass: 'AGENCY',
      accountId: ACCOUNT_ID,
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
    fakeState.syncedUser = {
      id: USER_ID,
      tenantId: TENANT_ID,
      userClass: 'AGENCY',
    };
    fakeState.resolvedPermissions = new Set(perms);
    fakeState.resolvedAccountId = ACCOUNT_ID;
  }

  function configureValidOperatorToken(perms: readonly Permission[]): void {
    fakeState.validResponse = {
      auth0Sub: 'auth0|ops',
      tenantId: TENANT_ID,
      userClass: 'OPERATOR',
      accountId: null,
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
    fakeState.syncedUser = {
      id: USER_ID,
      tenantId: TENANT_ID,
      userClass: 'OPERATOR',
    };
    fakeState.resolvedPermissions = new Set(perms);
    fakeState.resolvedAccountId = null;
  }

  async function postSearch(headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`${baseUrl}/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({
        tenantId: TENANT_ID,
        accountId: ACCOUNT_ID,
        supplierHotelIds: ['1000073'],
        checkIn: '2026-06-01',
        checkOut: '2026-06-03',
        occupancy: { adults: 2, children: 0 },
        currency: 'EUR',
      }),
    });
  }

  it('returns 401 when no Authorization header is present', async () => {
    resetFakes();
    const res = await postSearch();
    expect(res.status).toBe(401);
    // JwtAuthGuard short-circuits before RolesGuard / SearchService.
    expect(fakeValidator.validate).not.toHaveBeenCalled();
    expect(fakeResolver.resolve).not.toHaveBeenCalled();
    expect(fakeSearchService.search).not.toHaveBeenCalled();
  });

  it('returns 401 when the bearer token fails validation', async () => {
    resetFakes();
    const res = await postSearch({ authorization: `Bearer ${INVALID_TOKEN}` });
    expect(res.status).toBe(401);
    expect(fakeValidator.validate).toHaveBeenCalledWith(INVALID_TOKEN);
    expect(fakeResolver.resolve).not.toHaveBeenCalled();
    expect(fakeSearchService.search).not.toHaveBeenCalled();
  });

  it('returns 200/201 for an AGENCY user holding SEARCH_EXECUTE', async () => {
    resetFakes();
    configureValidAgencyToken([PERMISSIONS.SEARCH_EXECUTE]);
    const res = await postSearch({ authorization: `Bearer ${VALID_TOKEN}` });
    // Nest defaults a POST handler to 201 unless overridden.
    expect([200, 201]).toContain(res.status);
    // Guards ran in order: validate → sync → resolve → handler.
    expect(fakeValidator.validate).toHaveBeenCalledTimes(1);
    expect(fakeUserSync.syncOnAuthentication).toHaveBeenCalledTimes(1);
    expect(fakeResolver.resolve).toHaveBeenCalledTimes(1);
    expect(fakeSearchService.search).toHaveBeenCalledTimes(1);
  });

  it('returns 403 for an AGENCY user lacking SEARCH_EXECUTE', async () => {
    resetFakes();
    // user holds some other permission but not SEARCH_EXECUTE
    configureValidAgencyToken([PERMISSIONS.LEDGER_READ_ACCOUNT]);
    const res = await postSearch({ authorization: `Bearer ${VALID_TOKEN}` });
    expect(res.status).toBe(403);
    expect(fakeResolver.resolve).toHaveBeenCalledTimes(1);
    expect(fakeSearchService.search).not.toHaveBeenCalled();
  });

  it('returns 403 for an OPERATOR user without SEARCH_EXECUTE (D8 role matrix)', async () => {
    resetFakes();
    configureValidOperatorToken([
      PERMISSIONS.BOOKING_CANCEL_MANUAL,
      PERMISSIONS.AUDIT_READ,
    ]);
    const res = await postSearch({ authorization: `Bearer ${VALID_TOKEN}` });
    expect(res.status).toBe(403);
    expect(fakeSearchService.search).not.toHaveBeenCalled();
  });

  it('returns 403 for an OPERATOR holding SEARCH_EXECUTE (E4-B reconciliation: operator-as-self search disallowed)', async () => {
    // platform_admin holds every permission per the locked D8 rule,
    // so RolesGuard would let the operator pass. The controller's
    // E4-B reconciliation gate is what denies — operators have no
    // accountId and the search engine is account-scoped. When E8
    // ships, the impersonation guard will produce a synthetic
    // AGENCY-shaped AuthContext and this branch will be skipped.
    resetFakes();
    configureValidOperatorToken([PERMISSIONS.SEARCH_EXECUTE]);
    const res = await postSearch({ authorization: `Bearer ${VALID_TOKEN}` });
    expect(res.status).toBe(403);
    // Permission check happened (RolesGuard ran resolve()) — the deny
    // came from the controller, not from RolesGuard.
    expect(fakeResolver.resolve).toHaveBeenCalledTimes(1);
    expect(fakeSearchService.search).not.toHaveBeenCalled();
  });

  it('returns 403 when AGENCY body.accountId disagrees with AuthContext.accountId (E4-B)', async () => {
    resetFakes();
    configureValidAgencyToken([PERMISSIONS.SEARCH_EXECUTE]);
    const res = await fetch(`${baseUrl}/search`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${VALID_TOKEN}`,
      },
      body: JSON.stringify({
        tenantId: TENANT_ID,
        accountId: '01ARZ3NDEKTSV4RRFFQ69G5XXX', // not the user's account
        supplierHotelIds: ['1000073'],
        checkIn: '2026-06-01',
        checkOut: '2026-06-03',
        occupancy: { adults: 2, children: 0 },
        currency: 'EUR',
      }),
    });
    expect(res.status).toBe(403);
    expect(fakeResolver.resolve).toHaveBeenCalledTimes(1);
    expect(fakeSearchService.search).not.toHaveBeenCalled();
  });

  it('does not invoke SearchService when the JWT validator rejects', async () => {
    resetFakes();
    // No valid response configured — every token fails.
    const res = await postSearch({ authorization: `Bearer ${VALID_TOKEN}` });
    expect(res.status).toBe(401);
    expect(fakeUserSync.syncOnAuthentication).not.toHaveBeenCalled();
  });

  it('does not invoke SearchService when sync says the user is missing', async () => {
    resetFakes();
    fakeState.validResponse = {
      auth0Sub: 'auth0|new',
      tenantId: TENANT_ID,
      userClass: 'AGENCY',
      accountId: ACCOUNT_ID,
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
    // syncedUser stays null → MissingUserError → 401.
    const res = await postSearch({ authorization: `Bearer ${VALID_TOKEN}` });
    expect(res.status).toBe(401);
    expect(fakeResolver.resolve).not.toHaveBeenCalled();
    expect(fakeSearchService.search).not.toHaveBeenCalled();
  });
});
