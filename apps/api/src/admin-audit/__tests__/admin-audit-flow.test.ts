import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import {
  type INestApplication,
  type MiddlewareConsumer,
  Module,
  type NestModule,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AdminAuditController } from '../admin-audit.controller';
import { AuditEventService } from '../audit-event.service';
import { AuditEventRepository } from '../audit-event.repository';
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
 * ADR-028 V1.0 audit read API — HTTP-level end-to-end test.
 *
 * Boots a real Nest application with the production
 * `JwtAuthGuard` + `RolesGuard` + permission resolver. Fakes only the
 * boundaries (JWT validator, user sync, role repo, DB pool, audit
 * service, impersonation grant repo). Drives requests through fetch.
 *
 * Exercises:
 *   1.  operator with `AUDIT_READ` can LIST normal events
 *   2.  operator without `AUDIT_READ_SENSITIVE` cannot see SENSITIVE_ACCESS rows
 *   3.  operator without `AUDIT_READ_SENSITIVE` filtering for it → 403
 *   4.  platform_admin (has `AUDIT_READ_SENSITIVE`) can read SENSITIVE_ACCESS
 *   5.  operator with NO audit permission → 403
 *   6.  AGENCY user → 403
 *   7.  missing bearer → 401
 *   8.  X-Internal-Api-Key alone is NOT accepted (JWT-only)
 *   9.  cross-tenant rows are excluded
 *  10.  cursor pagination returns a second page
 *  11.  successful call emits AUDIT_QUERY_EXECUTED
 */

const TENANT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const OTHER_TENANT = '01ARZ3NDEKTSV4RRFFQ69G5OTH';
const PLATFORM_ADMIN_USER_ID = '01ARZ3NDEKTSV4RRFFQ69G5ADM';
const OPS_USER_ID = '01ARZ3NDEKTSV4RRFFQ69G5OPS';
const NO_AUDIT_USER_ID = '01ARZ3NDEKTSV4RRFFQ69G5NPP';
const AGENCY_USER_ID = '01ARZ3NDEKTSV4RRFFQ69G5AGY';
const AGENCY_ACCOUNT_ID = '01ARZ3NDEKTSV4RRFFQ69G5AAA';

const PLATFORM_ADMIN_TOKEN = 'admin.bearer';
const OPS_SUPPORT_TOKEN = 'ops.bearer';
const NO_AUDIT_TOKEN = 'no-audit.bearer';
const AGENCY_TOKEN = 'agency.bearer';

// ── In-memory audit_event store mirroring the SQL filter ──────────────

interface FakeRow {
  id: string;
  occurred_at: Date;
  recorded_at: Date;
  schema_version: number;
  category: string;
  kind: string;
  tenant_id: string;
  actor_kind: string;
  actor_user_id: string | null;
  actor_api_key_id: string | null;
  actor_label: string | null;
  target_kind: string | null;
  target_id: string | null;
  request_id: string | null;
  impersonation_grant_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
  payload: unknown;
}

function row(
  id: string,
  occurredAtMin: number,
  overrides: Partial<FakeRow> = {},
): FakeRow {
  return {
    id,
    occurred_at: new Date(Date.UTC(2026, 4, 13, 10, occurredAtMin, 0)),
    recorded_at: new Date(Date.UTC(2026, 4, 13, 10, occurredAtMin, 0)),
    schema_version: 1,
    category: 'APP',
    kind: 'BOOKING_CONFIRMED',
    tenant_id: TENANT_ID,
    actor_kind: 'USER',
    actor_user_id: PLATFORM_ADMIN_USER_ID,
    actor_api_key_id: null,
    actor_label: null,
    target_kind: 'BOOKING',
    target_id: 'BK-1',
    request_id: null,
    impersonation_grant_id: null,
    ip_address: '127.0.0.1',
    user_agent: 'test',
    payload: { ok: true },
    ...overrides,
  };
}

// Five rows: 3 normal in TENANT, 1 SENSITIVE_ACCESS in TENANT, 1 in OTHER_TENANT.
const EVENTS: FakeRow[] = [
  row('01ARZ3NDEKTSV4RRFFQ69G5R01', 1, { category: 'APP' }),
  row('01ARZ3NDEKTSV4RRFFQ69G5R02', 2, { category: 'AUTH' }),
  row('01ARZ3NDEKTSV4RRFFQ69G5R03', 3, { category: 'IMPERSONATION' }),
  row('01ARZ3NDEKTSV4RRFFQ69G5R04', 4, { category: 'SENSITIVE_ACCESS', kind: 'BOOKING_DETAIL_VIEWED_SENSITIVE' }),
  row('01ARZ3NDEKTSV4RRFFQ69G5R05', 5, { category: 'APP', tenant_id: OTHER_TENANT }),
];

class InMemoryAuditRepo {
  async listEvents(input: {
    tenantId: string;
    category?: string;
    includeSensitive: boolean;
    cursor?: { occurredAt: Date; id: string };
    limit: number;
  }): Promise<FakeRow[]> {
    let rows = EVENTS.filter((r) => r.tenant_id === input.tenantId);
    if (input.category !== undefined) {
      rows = rows.filter((r) => r.category === input.category);
    }
    if (!input.includeSensitive) {
      rows = rows.filter((r) => r.category !== 'SENSITIVE_ACCESS');
    }
    if (input.cursor !== undefined) {
      const c = input.cursor;
      rows = rows.filter((r) => {
        if (r.occurred_at.getTime() !== c.occurredAt.getTime()) {
          return r.occurred_at.getTime() < c.occurredAt.getTime();
        }
        return r.id < c.id;
      });
    }
    rows.sort((a, b) => {
      if (a.occurred_at.getTime() !== b.occurred_at.getTime()) {
        return b.occurred_at.getTime() - a.occurred_at.getTime();
      }
      return a.id < b.id ? 1 : -1;
    });
    return rows.slice(0, input.limit);
  }
}

const auditRepo = new InMemoryAuditRepo();

// ── Auth boundary fakes ───────────────────────────────────────────────

const fakeValidator = {
  validate: vi.fn(async (token: string) => {
    if (token === PLATFORM_ADMIN_TOKEN) {
      return { auth0Sub: 'auth0|admin',     tenantId: TENANT_ID, userClass: 'OPERATOR' as const, accountId: null, exp: Date.now() / 1000 + 3600 };
    }
    if (token === OPS_SUPPORT_TOKEN) {
      return { auth0Sub: 'auth0|ops',       tenantId: TENANT_ID, userClass: 'OPERATOR' as const, accountId: null, exp: Date.now() / 1000 + 3600 };
    }
    if (token === NO_AUDIT_TOKEN) {
      return { auth0Sub: 'auth0|no-audit',  tenantId: TENANT_ID, userClass: 'OPERATOR' as const, accountId: null, exp: Date.now() / 1000 + 3600 };
    }
    if (token === AGENCY_TOKEN) {
      return { auth0Sub: 'auth0|agency',    tenantId: TENANT_ID, userClass: 'AGENCY' as const,  accountId: AGENCY_ACCOUNT_ID, exp: Date.now() / 1000 + 3600 };
    }
    const { InvalidJwtError } = await import('../../auth/jwt/jwt-validator.service');
    throw new InvalidJwtError('test rejection');
  }),
};

const fakeUserSync = {
  syncOnAuthentication: vi.fn(async (input: { auth0Sub: string }) => {
    if (input.auth0Sub === 'auth0|admin')    return { id: PLATFORM_ADMIN_USER_ID, tenantId: TENANT_ID, auth0Sub: input.auth0Sub, email: 'admin@bb.test',   displayName: 'Admin',    userClass: 'OPERATOR' as const, status: 'ACTIVE' as const };
    if (input.auth0Sub === 'auth0|ops')      return { id: OPS_USER_ID,            tenantId: TENANT_ID, auth0Sub: input.auth0Sub, email: 'ops@bb.test',     displayName: 'Ops',      userClass: 'OPERATOR' as const, status: 'ACTIVE' as const };
    if (input.auth0Sub === 'auth0|no-audit') return { id: NO_AUDIT_USER_ID,       tenantId: TENANT_ID, auth0Sub: input.auth0Sub, email: 'no-audit@bb.test', displayName: 'NoAudit',  userClass: 'OPERATOR' as const, status: 'ACTIVE' as const };
    if (input.auth0Sub === 'auth0|agency')   return { id: AGENCY_USER_ID,         tenantId: TENANT_ID, auth0Sub: input.auth0Sub, email: 'agency@bb.test',  displayName: 'Agency',   userClass: 'AGENCY' as const,  status: 'ACTIVE' as const };
    throw new Error(`unmocked auth0Sub: ${input.auth0Sub}`);
  }),
};

const fakeRoleRepo = {
  // platform_admin → all permissions (including AUDIT_READ_SENSITIVE).
  // ops_support    → AUDIT_READ but NOT _SENSITIVE.
  // no-audit       → no roles.
  findActiveRolesForUser: vi.fn(async (_q: unknown, userId: string) => {
    if (userId === PLATFORM_ADMIN_USER_ID) return ['platform_admin'];
    if (userId === OPS_USER_ID)            return ['ops_support'];
    return [];
  }),
};

const fakeMembershipRepo = {
  findActiveByUser: vi.fn(async (_q: unknown, userId: string) => {
    if (userId === AGENCY_USER_ID) {
      return { userId, accountId: AGENCY_ACCOUNT_ID, roleName: 'account_admin' };
    }
    return null;
  }),
};

const auditEmitSpy = vi.fn();
const fakeAuditService = {
  emit: auditEmitSpy,
  emitMany: vi.fn(),
  emitInTransaction: vi.fn(async () => undefined),
};

const fakeImpersonationGrantRepo = {
  findActiveByActor: vi.fn(async () => null),
  findActiveWithTargetByActor: vi.fn(async () => null),
  findUnendedByActor: vi.fn(async () => null),
  insert: vi.fn(),
  end: vi.fn(),
};

const fakeJwks = { getKey: vi.fn() };
const fakePool = {
  query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  connect: vi.fn(async () => ({ query: vi.fn(), release: vi.fn() })),
};

@Module({
  controllers: [AdminAuditController],
  providers: [
    Reflector,
    JwtAuthGuard,
    RolesGuard,
    PermissionResolverService,
    AuditEventService,
    { provide: AuditEventRepository, useValue: auditRepo },
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

describe('GET /admin/audit/events — HTTP flow', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [FlowTestModule],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0);
    baseUrl = (await app.getUrl())
      .replace('[::1]', 'localhost')
      .replace('127.0.0.1', 'localhost');
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    auditEmitSpy.mockClear();
  });

  function withAuth(token: string): Record<string, string> {
    return { 'content-type': 'application/json', authorization: `Bearer ${token}` };
  }

  // ── Happy paths ─────────────────────────────────────────────────────

  it('1 — operator with AUDIT_READ can list normal events', async () => {
    const res = await fetch(`${baseUrl}/admin/audit/events`, {
      headers: withAuth(OPS_SUPPORT_TOKEN),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: { id: string; category: string }[]; nextCursor: string | null };
    // 3 non-sensitive rows in TENANT: APP / AUTH / IMPERSONATION.
    expect(body.events).toHaveLength(3);
    expect(body.events.map((e) => e.id)).toEqual([
      '01ARZ3NDEKTSV4RRFFQ69G5R03',
      '01ARZ3NDEKTSV4RRFFQ69G5R02',
      '01ARZ3NDEKTSV4RRFFQ69G5R01',
    ]);
    expect(body.events.some((e) => e.category === 'SENSITIVE_ACCESS')).toBe(false);
  });

  it('2 — operator with AUDIT_READ cannot see SENSITIVE_ACCESS rows (silently filtered)', async () => {
    const res = await fetch(`${baseUrl}/admin/audit/events`, {
      headers: withAuth(OPS_SUPPORT_TOKEN),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: { category: string }[] };
    expect(body.events.every((e) => e.category !== 'SENSITIVE_ACCESS')).toBe(true);
  });

  it('3 — operator without AUDIT_READ_SENSITIVE explicitly requesting SENSITIVE_ACCESS → 403', async () => {
    const res = await fetch(
      `${baseUrl}/admin/audit/events?category=SENSITIVE_ACCESS`,
      { headers: withAuth(OPS_SUPPORT_TOKEN) },
    );
    expect(res.status).toBe(403);
    // 4xx must NOT emit the audit event.
    expect(auditEmitSpy).not.toHaveBeenCalled();
  });

  it('4 — platform_admin can read SENSITIVE_ACCESS rows', async () => {
    const res = await fetch(
      `${baseUrl}/admin/audit/events?category=SENSITIVE_ACCESS`,
      { headers: withAuth(PLATFORM_ADMIN_TOKEN) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: { id: string }[] };
    expect(body.events).toHaveLength(1);
    expect(body.events[0]!.id).toBe('01ARZ3NDEKTSV4RRFFQ69G5R04');
  });

  // ── Permission rejections ───────────────────────────────────────────

  it('5 — operator without AUDIT_READ → 403', async () => {
    const res = await fetch(`${baseUrl}/admin/audit/events`, {
      headers: withAuth(NO_AUDIT_TOKEN),
    });
    expect(res.status).toBe(403);
    expect(auditEmitSpy).not.toHaveBeenCalled();
  });

  it('6 — AGENCY user → 403', async () => {
    const res = await fetch(`${baseUrl}/admin/audit/events`, {
      headers: withAuth(AGENCY_TOKEN),
    });
    expect(res.status).toBe(403);
  });

  // ── Auth boundary ───────────────────────────────────────────────────

  it('7 — missing Authorization header → 401', async () => {
    const res = await fetch(`${baseUrl}/admin/audit/events`);
    expect(res.status).toBe(401);
  });

  it('8 — X-Internal-Api-Key alone does NOT work (JWT-only)', async () => {
    const res = await fetch(`${baseUrl}/admin/audit/events`, {
      headers: { 'x-internal-api-key': 'any-value' },
    });
    expect(res.status).toBe(401);
  });

  // ── Tenant scope ────────────────────────────────────────────────────

  it('9 — cross-tenant rows are excluded (tenant scope sourced from AuthContext)', async () => {
    const res = await fetch(`${baseUrl}/admin/audit/events`, {
      headers: withAuth(PLATFORM_ADMIN_TOKEN),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: { tenantId: string }[] };
    expect(body.events.every((e) => e.tenantId === TENANT_ID)).toBe(true);
  });

  // ── Cursor pagination ───────────────────────────────────────────────

  it('10 — cursor pagination returns subsequent pages', async () => {
    const first = await fetch(
      `${baseUrl}/admin/audit/events?limit=2`,
      { headers: withAuth(OPS_SUPPORT_TOKEN) },
    );
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      events: { id: string }[];
      nextCursor: string | null;
    };
    expect(firstBody.events).toHaveLength(2);
    expect(firstBody.nextCursor).not.toBeNull();

    const second = await fetch(
      `${baseUrl}/admin/audit/events?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor!)}`,
      { headers: withAuth(OPS_SUPPORT_TOKEN) },
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { events: { id: string }[] };
    expect(secondBody.events.length).toBeGreaterThan(0);
    // No id repeated across pages.
    const firstIds = new Set(firstBody.events.map((e) => e.id));
    for (const e of secondBody.events) expect(firstIds.has(e.id)).toBe(false);
  });

  // ── Self-audit ──────────────────────────────────────────────────────

  it('11 — successful call emits AUDIT_QUERY_EXECUTED with filter shape', async () => {
    auditEmitSpy.mockClear();
    const res = await fetch(
      `${baseUrl}/admin/audit/events?category=APP`,
      { headers: withAuth(OPS_SUPPORT_TOKEN) },
    );
    expect(res.status).toBe(200);
    expect(auditEmitSpy).toHaveBeenCalledTimes(1);
    const [call] = auditEmitSpy.mock.calls[0]! as [unknown];
    expect(call).toMatchObject({
      category: 'SECURITY',
      kind: 'AUDIT_QUERY_EXECUTED',
      tenantId: TENANT_ID,
      payload: {
        endpoint: 'LIST',
        filters: { category: 'APP' },
        requiredPermission: 'AUDIT_READ',
      },
    });
  });

  it('11b — platform_admin call records requiredPermission=AUDIT_READ_SENSITIVE in the audit row', async () => {
    auditEmitSpy.mockClear();
    const res = await fetch(`${baseUrl}/admin/audit/events`, {
      headers: withAuth(PLATFORM_ADMIN_TOKEN),
    });
    expect(res.status).toBe(200);
    const [call] = auditEmitSpy.mock.calls[0]! as [{ payload: { requiredPermission: string } }];
    expect(call.payload.requiredPermission).toBe('AUDIT_READ_SENSITIVE');
  });
});
