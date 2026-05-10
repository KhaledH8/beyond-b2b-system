import { describe, expect, it, vi } from 'vitest';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { ImpersonationController } from '../impersonation/impersonation.controller';
import type { ImpersonationService } from '../impersonation/impersonation.service';
import type { AuthContext } from '../auth-context';

// ── Fixtures ────────────────────────────────────────────────────────────────

const TENANT_ID  = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const ACTOR_ID   = '01ARZ3NDEKTSV4RRFFQ69G5FBA';
const TARGET_ID  = '01ARZ3NDEKTSV4RRFFQ69G5FAC';
const GRANT_ID   = '01ARZ3NDEKTSV4RRFFQ69G5GRA';

function operatorAuth(): AuthContext {
  return {
    auth0Sub: 'auth0|operator',
    userId: ACTOR_ID,
    tenantId: TENANT_ID,
    accountId: null,
    userClass: 'OPERATOR',
  };
}

function impersonatingAuth(): AuthContext {
  return {
    auth0Sub: 'auth0|operator',
    userId: ACTOR_ID,
    tenantId: TENANT_ID,
    accountId: TARGET_ID,
    userClass: 'AGENCY',
    impersonation: {
      grantId: GRANT_ID,
      actorUserId: ACTOR_ID,
      actorAuth0Sub: 'auth0|operator',
      actorUserClass: 'OPERATOR',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      scope: 'READ_ONLY',
    },
  };
}

function makeService(overrides: Partial<ImpersonationService> = {}): ImpersonationService {
  return {
    startImpersonation: vi.fn(async () => ({
      grantId: GRANT_ID,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      target: { accountId: TARGET_ID, accountName: 'Acme Travel' },
    })),
    stopImpersonation: vi.fn(async () => ({ ended: true })),
    getActiveGrant: vi.fn(async () => null),
    ...overrides,
  } as unknown as ImpersonationService;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('ImpersonationController.start', () => {
  const validBody = {
    targetAccountId: TARGET_ID,
    reasonText: 'Investigating ticket',
    ticketRef: 'SUP-1234',
  };

  it('A — returns 201 shape on success', async () => {
    const ctrl = new ImpersonationController(makeService());
    const result = await ctrl.start(operatorAuth(), validBody);

    expect(result.grantId).toBe(GRANT_ID);
    expect(result.target.accountId).toBe(TARGET_ID);
    expect(result.target.accountName).toBe('Acme Travel');
  });

  it('B — throws 409 when already impersonating', async () => {
    const ctrl = new ImpersonationController(makeService());
    await expect(ctrl.start(impersonatingAuth(), validBody)).rejects.toThrow(
      ConflictException,
    );
  });

  it('C — delegates correct input to service', async () => {
    const svc = makeService();
    const ctrl = new ImpersonationController(svc);
    await ctrl.start(operatorAuth(), validBody);

    expect(svc.startImpersonation).toHaveBeenCalledWith({
      actorUserId: ACTOR_ID,
      actorAuth0Sub: 'auth0|operator',
      actorTenantId: TENANT_ID,
      targetAccountId: TARGET_ID,
      reasonText: 'Investigating ticket',
      ticketRef: 'SUP-1234',
    });
  });

  it('D — propagates service errors (e.g. ForbiddenException from cross-tenant)', async () => {
    const svc = makeService({
      startImpersonation: vi.fn(async () => {
        throw new ForbiddenException('Target account belongs to a different tenant');
      }),
    });
    const ctrl = new ImpersonationController(svc);
    await expect(ctrl.start(operatorAuth(), validBody)).rejects.toThrow(
      ForbiddenException,
    );
  });
});

describe('ImpersonationController.stop', () => {
  it('E — returns ended=true when grant was active', async () => {
    const ctrl = new ImpersonationController(makeService());
    const result = await ctrl.stop(operatorAuth());
    expect(result.ended).toBe(true);
  });

  it('F — returns ended=false when no active grant (idempotent)', async () => {
    const svc = makeService({
      stopImpersonation: vi.fn(async () => ({ ended: false })),
    });
    const ctrl = new ImpersonationController(svc);
    const result = await ctrl.stop(operatorAuth());
    expect(result.ended).toBe(false);
  });

  it('G — works while the operator context is AGENCY-shaped (impersonation active)', async () => {
    const svc = makeService({
      stopImpersonation: vi.fn(async () => ({ ended: true })),
    });
    const ctrl = new ImpersonationController(svc);
    // Should not throw — stop is reachable during active impersonation
    const result = await ctrl.stop(impersonatingAuth());
    expect(result.ended).toBe(true);
    expect(svc.stopImpersonation).toHaveBeenCalledWith(ACTOR_ID, TENANT_ID);
  });
});

describe('ImpersonationController.active', () => {
  it('H — returns null when no active grant', async () => {
    const ctrl = new ImpersonationController(makeService());
    expect(await ctrl.active(operatorAuth())).toBeNull();
  });

  it('I — returns { grant, target } shape when an active grant exists', async () => {
    const grantRecord = {
      id: GRANT_ID,
      tenantId: TENANT_ID,
      actorUserId: ACTOR_ID,
      targetAccountId: TARGET_ID,
      reasonText: 'Investigating ticket',
      ticketRef: 'SUP-1234',
      scope: 'READ_ONLY' as const,
      startedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      endedAt: null,
      endedReason: null,
      ipAddress: null,
      userAgent: null,
    };
    const view = {
      grant: grantRecord,
      target: { accountId: TARGET_ID, accountName: 'Acme Travel' },
    };
    const svc = makeService({
      getActiveGrant: vi.fn(async () => view),
    });
    const ctrl = new ImpersonationController(svc);
    const result = await ctrl.active(operatorAuth());
    expect(result?.grant.id).toBe(GRANT_ID);
    expect(result?.grant.targetAccountId).toBe(TARGET_ID);
    expect(result?.grant.ticketRef).toBe('SUP-1234');
    expect(result?.target.accountId).toBe(TARGET_ID);
    expect(result?.target.accountName).toBe('Acme Travel');
  });
});
