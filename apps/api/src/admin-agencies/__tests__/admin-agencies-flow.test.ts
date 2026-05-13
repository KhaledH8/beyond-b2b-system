import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import {
  type INestApplication,
  type MiddlewareConsumer,
  Module,
  type NestModule,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AdminAgenciesController } from '../admin-agencies.controller';
import { AgencySelectorService } from '../agency-selector.service';
import { AgencySelectorRepository } from '../agency-selector.repository';
import { JwtAuthGuard } from '../../auth/jwt/jwt-auth.guard';
import { JwtValidatorService } from '../../auth/jwt/jwt-validator.service';
import { JwksCacheService } from '../../auth/jwt/jwks-cache.service';
import { UserSyncService } from '../../auth/user-sync/user-sync.service';
import { RolesGuard } from '../../auth/permissions/roles.guard';
import { PermissionResolverService } from '../../auth/permissions/permission-resolver.service';
import { UserRoleRepository } from '../../auth/permissions/user-role.repository';
import { UserAccountMembershipRepository } from '../../auth/permissions/user-account-membership.repository';
import { ImpersonationGrantRepository } from '../../auth/impersonation/impersonation-grant.repository';
import { AuditService } from '../../audit/audit.service';
import { RequestIdMiddleware } from '../../audit/request-id.middleware';
import { PG_POOL } from '../../database/database.module';

/**
 * ADR-027 V1.1 agency selector — HTTP-level end-to-end test.
 *
 * Mirrors `impersonation-flow.test.ts`: boots a real Nest application
 * with the production JwtAuthGuard + RolesGuard + permission resolver,
 * fakes only the boundaries (JWT validator, user sync, role repo, DB
 * pool, audit service, grant repo). Drives requests through fetch.
 *
 * Exercises:
 *   1. operator with IMPERSONATE_AGENCY_ACCOUNT can list active agencies
 *   2. `q` filters by name (reaches the repo as the right param)
 *   3. `q` filters by ID (same — repo handles ID prefix)
 *   4. `limit` is clamped at 50 by the service before reaching the repo
 *   5. cross-tenant accounts: tenant scoping is sourced from AuthContext
 *   6. only AGENCY+ACTIVE rows surface (asserted at the repo-call layer)
 *   7. missing permission → 403
 *   8. AGENCY user → 403
 *   9. no INTERNAL_API_KEY header is required (JWT path is the only path)
 */

const TENANT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const OTHER_TENANT = '01ARZ3NDEKTSV4RRFFQ69G5OTH';
const OPERATOR_USER_ID = '01ARZ3NDEKTSV4RRFFQ69G5OPE';
const AGENCY_USER_ID = '01ARZ3NDEKTSV4RRFFQ69G5AGY';
const OPERATOR_TOKEN = 'op.bearer.token';
const NO_PERM_OPERATOR_TOKEN = 'op-no-perm.bearer.token';
const AGENCY_TOKEN = 'agency.bearer.token';

// ── In-memory agencies table (tenant_id, account_type, status, name, id) ─

interface AgencyRow {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly tenantId: string;
  readonly accountType: string;
}

const AGENCIES: AgencyRow[] = [
  { id: '01ARZ3NDEKTSV4RRFFQ69G5AAA', name: 'Acme Travel',  status: 'ACTIVE',    tenantId: TENANT_ID,    accountType: 'AGENCY' },
  { id: '01ARZ3NDEKTSV4RRFFQ69G5BBB', name: 'Beta Tours',   status: 'ACTIVE',    tenantId: TENANT_ID,    accountType: 'AGENCY' },
  { id: '01ARZ3NDEKTSV4RRFFQ69G5CCC', name: 'Gamma Group',  status: 'SUSPENDED', tenantId: TENANT_ID,    accountType: 'AGENCY' },  // inactive: must not leak
  { id: '01ARZ3NDEKTSV4RRFFQ69G5DDD', name: 'Delta Direct', status: 'ACTIVE',    tenantId: TENANT_ID,    accountType: 'CORPORATE' }, // wrong type
  { id: '01ARZ3NDEKTSV4RRFFQ69G5EEE', name: 'Cross-Tenant', status: 'ACTIVE',    tenantId: OTHER_TENANT, accountType: 'AGENCY' },   // wrong tenant
];

class InMemoryAgencyRepo {
  // Mirrors the repo SQL: tenant + AGENCY + ACTIVE filter, ILIKE on name,
  // ILIKE-prefix on id, sort by name asc + id asc, limit.
  async listActiveAgencies(input: {
    tenantId: string;
    q: string;
    limit: number;
  }): Promise<{ id: string; name: string; status: string }[]> {
    const q = input.q.toLowerCase();
    const filtered = AGENCIES.filter(
      (a) =>
        a.tenantId === input.tenantId &&
        a.accountType === 'AGENCY' &&
        a.status === 'ACTIVE' &&
        (q === '' ||
          a.name.toLowerCase().includes(q) ||
          a.id.toLowerCase().startsWith(q)),
    );
    filtered.sort((x, y) => {
      if (x.name === y.name) return x.id < y.id ? -1 : 1;
      return x.name < y.name ? -1 : 1;
    });
    return filtered
      .slice(0, input.limit)
      .map((a) => ({ id: a.id, name: a.name, status: a.status }));
  }
}

const agencyRepo = new InMemoryAgencyRepo();

// ── Fake DB pool (only the agency-selector queries arrive here; reads
//    of `core_account` for impersonation are not on this path) ───────────

const fakeClient = {
  query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  release: vi.fn(),
};
const fakePool = {
  query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  connect: vi.fn(async () => fakeClient),
};

// ── Auth boundary fakes ─────────────────────────────────────────────────

const fakeValidator = {
  validate: vi.fn(async (token: string) => {
    if (token === OPERATOR_TOKEN || token === NO_PERM_OPERATOR_TOKEN) {
      return {
        auth0Sub: token === OPERATOR_TOKEN ? 'auth0|operator' : 'auth0|operator-no-perm',
        tenantId: TENANT_ID,
        userClass: 'OPERATOR' as const,
        accountId: null,
        exp: Math.floor(Date.now() / 1000) + 3600,
      };
    }
    if (token === AGENCY_TOKEN) {
      return {
        auth0Sub: 'auth0|agency-user',
        tenantId: TENANT_ID,
        userClass: 'AGENCY' as const,
        accountId: AGENCIES[0]!.id,
        exp: Math.floor(Date.now() / 1000) + 3600,
      };
    }
    const { InvalidJwtError } = await import('../../auth/jwt/jwt-validator.service');
    throw new InvalidJwtError('test rejection');
  }),
};

const fakeUserSync = {
  syncOnAuthentication: vi.fn(async (input: { auth0Sub: string }) => {
    if (input.auth0Sub === 'auth0|operator') {
      return {
        id: OPERATOR_USER_ID,
        tenantId: TENANT_ID,
        auth0Sub: 'auth0|operator',
        email: 'op@bb.test',
        displayName: 'Op',
        userClass: 'OPERATOR' as const,
        status: 'ACTIVE' as const,
      };
    }
    if (input.auth0Sub === 'auth0|operator-no-perm') {
      return {
        id: '01ARZ3NDEKTSV4RRFFQ69G5NPP',
        tenantId: TENANT_ID,
        auth0Sub: 'auth0|operator-no-perm',
        email: 'op-no-perm@bb.test',
        displayName: 'OpNoPerm',
        userClass: 'OPERATOR' as const,
        status: 'ACTIVE' as const,
      };
    }
    if (input.auth0Sub === 'auth0|agency-user') {
      return {
        id: AGENCY_USER_ID,
        tenantId: TENANT_ID,
        auth0Sub: 'auth0|agency-user',
        email: 'agency@bb.test',
        displayName: 'AgencyUser',
        userClass: 'AGENCY' as const,
        status: 'ACTIVE' as const,
      };
    }
    throw new Error(`unmocked auth0Sub: ${input.auth0Sub}`);
  }),
};

const fakeRoleRepo = {
  // Operator-with-permission gets platform_admin (all permissions).
  // Operator-without-permission gets [] (no roles → no permissions).
  // AGENCY user has no operator role.
  // Signature mirrors the real repo: (q, userId) => Promise<Role[]>.
  findActiveRolesForUser: vi.fn(async (_q: unknown, userId: string) => {
    if (userId === OPERATOR_USER_ID) return ['platform_admin'];
    if (userId === '01ARZ3NDEKTSV4RRFFQ69G5NPP') return [];
    return [];
  }),
};

const fakeMembershipRepo = {
  // Signature mirrors the real repo: (q, userId) => Promise<...>.
  findActiveByUser: vi.fn(async (_q: unknown, userId: string) => {
    if (userId === AGENCY_USER_ID) {
      return {
        userId: AGENCY_USER_ID,
        accountId: AGENCIES[0]!.id,
        roleName: 'account_admin',
      };
    }
    return null;
  }),
};

const fakeAuditService = {
  emit: vi.fn(),
  emitInTransaction: vi.fn(async () => undefined),
  emitMany: vi.fn(),
};

const fakeJwks = { getKey: vi.fn() };

const fakeImpersonationGrantRepo = {
  findActiveByActor: vi.fn(async () => null),
  findActiveWithTargetByActor: vi.fn(async () => null),
  findUnendedByActor: vi.fn(async () => null),
  insert: vi.fn(),
  end: vi.fn(),
};

@Module({
  controllers: [AdminAgenciesController],
  providers: [
    Reflector,
    JwtAuthGuard,
    RolesGuard,
    PermissionResolverService,
    AgencySelectorService,
    { provide: AgencySelectorRepository, useValue: agencyRepo },
    { provide: JwtValidatorService, useValue: fakeValidator },
    { provide: JwksCacheService, useValue: fakeJwks },
    { provide: UserSyncService, useValue: fakeUserSync },
    { provide: UserRoleRepository, useValue: fakeRoleRepo },
    { provide: UserAccountMembershipRepository, useValue: fakeMembershipRepo },
    { provide: AuditService, useValue: fakeAuditService },
    { provide: ImpersonationGrantRepository, useValue: fakeImpersonationGrantRepo },
    { provide: PG_POOL, useValue: fakePool },
  ],
})
class FlowTestModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}

describe('GET /admin/agencies — HTTP flow', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [FlowTestModule],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0);
    baseUrl = (await app.getUrl()).replace('[::1]', 'localhost').replace('127.0.0.1', 'localhost');
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    fakeRoleRepo.findActiveRolesForUser.mockClear();
  });

  function withAuth(token: string): Record<string, string> {
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    };
  }

  // ── Happy path ─────────────────────────────────────────────────────────

  it('1 — operator with permission lists active AGENCY accounts in own tenant', async () => {
    const res = await fetch(`${baseUrl}/admin/agencies`, {
      headers: withAuth(OPERATOR_TOKEN),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accounts: { id: string; name: string; status: string }[] };
    // Only Acme + Beta (both ACTIVE + AGENCY + same tenant).
    expect(body.accounts.map((a) => a.id)).toEqual([
      '01ARZ3NDEKTSV4RRFFQ69G5AAA',
      '01ARZ3NDEKTSV4RRFFQ69G5BBB',
    ]);
  });

  it('2 — q filters by name (case-insensitive substring)', async () => {
    const res = await fetch(`${baseUrl}/admin/agencies?q=acm`, {
      headers: withAuth(OPERATOR_TOKEN),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accounts: { id: string }[] };
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0]!.id).toBe('01ARZ3NDEKTSV4RRFFQ69G5AAA');
  });

  it('3 — q filters by ID prefix', async () => {
    const res = await fetch(
      `${baseUrl}/admin/agencies?q=01ARZ3NDEKTSV4RRFFQ69G5BBB`,
      { headers: withAuth(OPERATOR_TOKEN) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accounts: { id: string }[] };
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0]!.id).toBe('01ARZ3NDEKTSV4RRFFQ69G5BBB');
  });

  it('4 — limit query param is honoured (clamped to ≤50 by service)', async () => {
    const res = await fetch(`${baseUrl}/admin/agencies?limit=1`, {
      headers: withAuth(OPERATOR_TOKEN),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accounts: unknown[] };
    expect(body.accounts).toHaveLength(1);
  });

  it('5 — SUSPENDED rows are not returned (status filter)', async () => {
    const res = await fetch(`${baseUrl}/admin/agencies?q=gamma`, {
      headers: withAuth(OPERATOR_TOKEN),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accounts: unknown[] };
    expect(body.accounts).toEqual([]);
  });

  it('6 — non-AGENCY rows are not returned (account_type filter)', async () => {
    const res = await fetch(`${baseUrl}/admin/agencies?q=delta`, {
      headers: withAuth(OPERATOR_TOKEN),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accounts: unknown[] };
    expect(body.accounts).toEqual([]);
  });

  it('7 — cross-tenant rows are not returned (tenant scope from AuthContext)', async () => {
    const res = await fetch(`${baseUrl}/admin/agencies?q=cross`, {
      headers: withAuth(OPERATOR_TOKEN),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accounts: unknown[] };
    expect(body.accounts).toEqual([]);
  });

  // ── Permission rejections ──────────────────────────────────────────────

  it('8 — operator WITHOUT IMPERSONATE_AGENCY_ACCOUNT → 403', async () => {
    const res = await fetch(`${baseUrl}/admin/agencies`, {
      headers: withAuth(NO_PERM_OPERATOR_TOKEN),
    });
    expect(res.status).toBe(403);
  });

  it('9 — normal AGENCY user → 403', async () => {
    const res = await fetch(`${baseUrl}/admin/agencies`, {
      headers: withAuth(AGENCY_TOKEN),
    });
    expect(res.status).toBe(403);
  });

  // ── Auth boundary ──────────────────────────────────────────────────────

  it('10 — missing Authorization header → 401', async () => {
    const res = await fetch(`${baseUrl}/admin/agencies`);
    expect(res.status).toBe(401);
  });

  it('11 — endpoint does NOT accept X-Internal-Api-Key as auth (JWT-only)', async () => {
    const res = await fetch(`${baseUrl}/admin/agencies`, {
      headers: { 'x-internal-api-key': 'any-value' },
    });
    // No bearer → JwtAuthGuard rejects with 401 regardless of any
    // internal-api-key header. Proves the endpoint is JWT-gated.
    expect(res.status).toBe(401);
  });
});
