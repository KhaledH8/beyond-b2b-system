import { describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AdminAuditController } from '../admin-audit.controller';
import type { AuditEventService } from '../audit-event.service';
import type { PermissionResolverService } from '../../auth/permissions/permission-resolver.service';
import type { AuditService } from '../../audit/audit.service';
import type { AuthContext } from '../../auth/auth-context';
import { JwtAuthGuard } from '../../auth/jwt/jwt-auth.guard';
import { RolesGuard } from '../../auth/permissions/roles.guard';
import { InternalAuthGuard } from '../../internal-auth/internal-auth.guard';
import { PERMISSIONS } from '../../auth/permissions/permissions';
import { REQUIRE_PERMISSION_KEY } from '../../auth/permissions/require-permission.decorator';

const TENANT = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const OPERATOR_ID = '01ARZ3NDEKTSV4RRFFQ69G5OPE';

function operatorAuth(): AuthContext {
  return {
    auth0Sub: 'auth0|operator',
    userId: OPERATOR_ID,
    tenantId: TENANT,
    accountId: null,
    userClass: 'OPERATOR',
  };
}

function makeService(
  result: Awaited<ReturnType<AuditEventService['listEvents']>> = {
    events: [],
    nextCursor: null,
    appliedFilters: {},
  },
): AuditEventService {
  return { listEvents: vi.fn(async () => result) } as unknown as AuditEventService;
}

function makeResolver(
  permissions: Set<string> = new Set([PERMISSIONS.AUDIT_READ]),
): PermissionResolverService {
  return {
    resolve: vi.fn(async () => ({
      userId: OPERATOR_ID,
      userClass: 'OPERATOR',
      roles: [],
      permissions,
      accountId: null,
    })),
  } as unknown as PermissionResolverService;
}

function makeAudit(): AuditService {
  return {
    emit: vi.fn(),
    emitMany: vi.fn(),
    emitInTransaction: vi.fn(async () => undefined),
  } as unknown as AuditService;
}

// ── Delegation ────────────────────────────────────────────────────────

describe('AdminAuditController.list — delegation', () => {
  it('A — sources tenantId from AuthContext, not from query', async () => {
    const svc = makeService();
    const ctrl = new AdminAuditController(svc, makeResolver(), makeAudit());
    await ctrl.list(operatorAuth());
    expect(svc.listEvents).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT }),
    );
  });

  it('B — passes through all filter query params', async () => {
    const svc = makeService();
    const ctrl = new AdminAuditController(svc, makeResolver(), makeAudit());
    await ctrl.list(
      operatorAuth(),
      'IMPERSONATION',
      'IMPERSONATION_STARTED',
      OPERATOR_ID,
      'ACCOUNT',
      '01ARZ3NDEKTSV4RRFFQ69G5TGT',
      '01ARZ3NDEKTSV4RRFFQ69G5REQ',
      '01ARZ3NDEKTSV4RRFFQ69G5GRA',
      '2026-05-01T00:00:00Z',
      '2026-05-14T00:00:00Z',
      '25',
      undefined,
    );
    expect(svc.listEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'IMPERSONATION',
        kind: 'IMPERSONATION_STARTED',
        actorUserId: OPERATOR_ID,
        targetKind: 'ACCOUNT',
        targetId: '01ARZ3NDEKTSV4RRFFQ69G5TGT',
        requestId: '01ARZ3NDEKTSV4RRFFQ69G5REQ',
        impersonationGrantId: '01ARZ3NDEKTSV4RRFFQ69G5GRA',
        occurredFrom: '2026-05-01T00:00:00Z',
        occurredTo: '2026-05-14T00:00:00Z',
        limit: 25,
      }),
    );
  });

  it('C — parses limit string to number', async () => {
    const svc = makeService();
    const ctrl = new AdminAuditController(svc, makeResolver(), makeAudit());
    await ctrl.list(
      operatorAuth(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      '7',
      undefined,
    );
    expect(svc.listEvents).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 7 }),
    );
  });

  it('D — empty-string limit treated as missing', async () => {
    const svc = makeService();
    const ctrl = new AdminAuditController(svc, makeResolver(), makeAudit());
    await ctrl.list(
      operatorAuth(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      '',
      undefined,
    );
    expect(svc.listEvents).toHaveBeenCalledWith(
      expect.objectContaining({ limit: undefined }),
    );
  });

  it('E — returns the service result verbatim (events + nextCursor)', async () => {
    const svc = makeService({
      events: [
        {
          id: '01ARZ3NDEKTSV4RRFFQ69G5AAA',
          occurredAt: '2026-05-13T10:00:00.000Z',
          recordedAt: '2026-05-13T10:00:00.500Z',
          schemaVersion: 1,
          category: 'APP',
          kind: 'BOOKING_CONFIRMED',
          tenantId: TENANT,
          actorKind: 'USER',
          actorUserId: OPERATOR_ID,
          actorApiKeyId: null,
          actorLabel: null,
          targetKind: 'BOOKING',
          targetId: 'BK-1',
          requestId: null,
          impersonationGrantId: null,
          ipAddress: null,
          userAgent: null,
          payload: {},
        },
      ],
      nextCursor: 'opaque-string',
      appliedFilters: {},
    });
    const ctrl = new AdminAuditController(svc, makeResolver(), makeAudit());
    const result = await ctrl.list(operatorAuth());
    expect(result.events).toHaveLength(1);
    expect(result.nextCursor).toBe('opaque-string');
  });
});

// ── Sensitive permission check ────────────────────────────────────────

describe('AdminAuditController.list — sensitive permission check', () => {
  it('F — caller without AUDIT_READ_SENSITIVE + category=SENSITIVE_ACCESS → 403', async () => {
    const svc = makeService();
    const ctrl = new AdminAuditController(svc, makeResolver(), makeAudit());
    await expect(
      ctrl.list(operatorAuth(), 'SENSITIVE_ACCESS'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(svc.listEvents).not.toHaveBeenCalled();
  });

  it('G — caller WITH AUDIT_READ_SENSITIVE + category=SENSITIVE_ACCESS → service called with canViewSensitive=true', async () => {
    const svc = makeService();
    const resolver = makeResolver(
      new Set([PERMISSIONS.AUDIT_READ, PERMISSIONS.AUDIT_READ_SENSITIVE]),
    );
    const ctrl = new AdminAuditController(svc, resolver, makeAudit());
    await ctrl.list(operatorAuth(), 'SENSITIVE_ACCESS');
    expect(svc.listEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        canViewSensitive: true,
        category: 'SENSITIVE_ACCESS',
      }),
    );
  });

  it('H — caller without AUDIT_READ_SENSITIVE but NOT filtering SENSITIVE_ACCESS → 200 with canViewSensitive=false', async () => {
    const svc = makeService();
    const ctrl = new AdminAuditController(svc, makeResolver(), makeAudit());
    await ctrl.list(operatorAuth());
    expect(svc.listEvents).toHaveBeenCalledWith(
      expect.objectContaining({ canViewSensitive: false }),
    );
  });
});

// ── Self-audit emission ──────────────────────────────────────────────

describe('AdminAuditController.list — self-audit', () => {
  it('I — successful call emits AUDIT_QUERY_EXECUTED with the applied filters', async () => {
    const svc = makeService({
      events: [],
      nextCursor: null,
      appliedFilters: { category: 'APP', kind: 'BOOKING_CONFIRMED' },
    });
    const audit = makeAudit();
    const ctrl = new AdminAuditController(svc, makeResolver(), audit);
    await ctrl.list(operatorAuth(), 'APP', 'BOOKING_CONFIRMED');
    expect(audit.emit).toHaveBeenCalledWith({
      category: 'SECURITY',
      kind: 'AUDIT_QUERY_EXECUTED',
      tenantId: TENANT,
      payload: {
        endpoint: 'LIST',
        filters: { category: 'APP', kind: 'BOOKING_CONFIRMED' },
        resultCount: 0,
        requiredPermission: 'AUDIT_READ',
      },
    });
  });

  it('J — sensitive caller has requiredPermission=AUDIT_READ_SENSITIVE in the payload', async () => {
    const svc = makeService();
    const audit = makeAudit();
    const resolver = makeResolver(
      new Set([PERMISSIONS.AUDIT_READ, PERMISSIONS.AUDIT_READ_SENSITIVE]),
    );
    const ctrl = new AdminAuditController(svc, resolver, audit);
    await ctrl.list(operatorAuth());
    expect(audit.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          requiredPermission: 'AUDIT_READ_SENSITIVE',
        }),
      }),
    );
  });

  it('K — rejected 403 (sensitive category without permission) does NOT emit', async () => {
    const audit = makeAudit();
    const ctrl = new AdminAuditController(makeService(), makeResolver(), audit);
    await expect(
      ctrl.list(operatorAuth(), 'SENSITIVE_ACCESS'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(audit.emit).not.toHaveBeenCalled();
  });

  it('L — audit.emit throwing does NOT fail the request', async () => {
    const audit = {
      emit: vi.fn(() => {
        throw new Error('audit queue full');
      }),
    } as unknown as AuditService;
    const ctrl = new AdminAuditController(makeService(), makeResolver(), audit);
    const result = await ctrl.list(operatorAuth());
    expect(result.events).toEqual([]);
  });
});

// ── Guard + permission metadata ──────────────────────────────────────

describe('AdminAuditController — guard + permission metadata', () => {
  const reflector = new Reflector();

  it('M — declares JwtAuthGuard + RolesGuard via @UseGuards (NOT InternalAuthGuard)', () => {
    const guards = reflector.get<unknown[]>('__guards__', AdminAuditController);
    expect(guards).toBeDefined();
    const names = guards!.map((g) => (g as { name?: string })?.name);
    expect(names).toContain(JwtAuthGuard.name);
    expect(names).toContain(RolesGuard.name);
    expect(names).not.toContain(InternalAuthGuard.name);
  });

  it('N — `list` requires AUDIT_READ (base permission, NOT sensitive)', () => {
    const required = reflector.get<readonly string[]>(
      REQUIRE_PERMISSION_KEY,
      AdminAuditController.prototype.list,
    );
    expect(required).toEqual([PERMISSIONS.AUDIT_READ]);
  });
});
