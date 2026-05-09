import { describe, expect, it, vi } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import type { Pool, PoolClient } from '@bb/db';
import {
  ImpersonationService,
  parseTtlMinutes,
} from '../impersonation/impersonation.service';
import type { ImpersonationGrantRepository } from '../impersonation/impersonation-grant.repository';
import type { AuditService } from '../../audit/audit.service';

// ── Fixtures ────────────────────────────────────────────────────────────────

const TENANT_ID  = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const ACTOR_ID   = '01ARZ3NDEKTSV4RRFFQ69G5FBA';
const TARGET_ID  = '01ARZ3NDEKTSV4RRFFQ69G5FAC';
const GRANT_ID   = '01ARZ3NDEKTSV4RRFFQ69G5GRA';
const OTHER_TID  = '01ARZ3NDEKTSV4RRFFQ69G5OTH';

const BASE_INPUT = {
  actorUserId:    ACTOR_ID,
  actorAuth0Sub:  'auth0|actor',
  actorTenantId:  TENANT_ID,
  targetAccountId: TARGET_ID,
  reasonText:     'Investigating ticket',
  ticketRef:      'SUP-1234',
};

const AGENCY_ACCOUNT = {
  id: TARGET_ID,
  tenant_id: TENANT_ID,
  account_type: 'AGENCY',
  name: 'Acme Travel',
};

const ACTIVE_GRANT = {
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

const EXPIRED_GRANT = {
  ...ACTIVE_GRANT,
  expiresAt: new Date(Date.now() - 1_000).toISOString(), // past
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeClient(): PoolClient {
  return {
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    release: vi.fn(),
  } as unknown as PoolClient;
}

function makePool(accountRow: object | null = AGENCY_ACCOUNT, client?: PoolClient) {
  const cl = client ?? makeClient();
  return {
    connect: vi.fn(async () => cl),
    query: vi.fn(async (sql: string) => {
      if (sql.includes('FROM core_account')) {
        return { rows: accountRow ? [accountRow] : [], rowCount: accountRow ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    }),
  } as unknown as Pool;
}

function makeGrantRepo(overrides: Partial<ImpersonationGrantRepository> = {}): ImpersonationGrantRepository {
  return {
    findActiveByActor: vi.fn(async () => null),
    findUnendedByActor: vi.fn(async () => null),
    insert: vi.fn(async () => ACTIVE_GRANT),
    end: vi.fn(async () => ({ rowsUpdated: 1, grantId: GRANT_ID })),
    ...overrides,
  } as unknown as ImpersonationGrantRepository;
}

function makeAudit(): AuditService {
  return {
    emit: vi.fn(),
    emitInTransaction: vi.fn(async () => undefined),
  } as unknown as AuditService;
}

function makeService(
  pool: Pool,
  grantRepo: ImpersonationGrantRepository,
  audit: AuditService,
): ImpersonationService {
  const svc = new ImpersonationService(pool, grantRepo, audit);
  return svc;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('ImpersonationService.startImpersonation', () => {
  it('A — inserts grant and emits IMPERSONATION_STARTED on success', async () => {
    const client = makeClient();
    (client.query as ReturnType<typeof vi.fn>).mockResolvedValue({
      rows: [],
      rowCount: 0,
    });
    const pool = makePool(AGENCY_ACCOUNT, client);
    const grantRepo = makeGrantRepo({ findUnendedByActor: vi.fn(async () => null) });
    const audit = makeAudit();

    const svc = makeService(pool, grantRepo, audit);
    const result = await svc.startImpersonation(BASE_INPUT);

    expect(result.grantId).toBe(ACTIVE_GRANT.id);
    expect(result.target.accountName).toBe('Acme Travel');
    expect(grantRepo.insert).toHaveBeenCalledOnce();
    expect(audit.emitInTransaction).toHaveBeenCalledWith(
      client,
      expect.objectContaining({
        category: 'IMPERSONATION',
        kind: 'IMPERSONATION_STARTED',
      }),
    );
  });

  it('B — throws 400 when ticketRef is empty', async () => {
    const pool = makePool();
    const grantRepo = makeGrantRepo();
    const audit = makeAudit();
    const svc = makeService(pool, grantRepo, audit);

    await expect(
      svc.startImpersonation({ ...BASE_INPUT, ticketRef: '  ' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('C — throws 400 when reasonText is empty', async () => {
    const pool = makePool();
    const grantRepo = makeGrantRepo();
    const audit = makeAudit();
    const svc = makeService(pool, grantRepo, audit);

    await expect(
      svc.startImpersonation({ ...BASE_INPUT, reasonText: '' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('D — throws 403 when target account is not found', async () => {
    const pool = makePool(null); // no account row
    const client = makeClient();
    // override connect for the tx phase — but validation fires first
    (pool.connect as ReturnType<typeof vi.fn>).mockResolvedValue(client);
    const audit = makeAudit();
    const grantRepo = makeGrantRepo();
    const svc = makeService(pool, grantRepo, audit);

    await expect(svc.startImpersonation(BASE_INPUT)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('E — throws 403 when target account is not AGENCY type', async () => {
    const corporateAccount = { ...AGENCY_ACCOUNT, account_type: 'CORPORATE' };
    const pool = makePool(corporateAccount);
    const client = makeClient();
    (pool.connect as ReturnType<typeof vi.fn>).mockResolvedValue(client);
    const audit = makeAudit();
    const grantRepo = makeGrantRepo();
    const svc = makeService(pool, grantRepo, audit);

    await expect(svc.startImpersonation(BASE_INPUT)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('F — throws 403 when target account belongs to a different tenant', async () => {
    const crossTenantAccount = { ...AGENCY_ACCOUNT, tenant_id: OTHER_TID };
    const pool = makePool(crossTenantAccount);
    const client = makeClient();
    (pool.connect as ReturnType<typeof vi.fn>).mockResolvedValue(client);
    const audit = makeAudit();
    const grantRepo = makeGrantRepo();
    const svc = makeService(pool, grantRepo, audit);

    await expect(svc.startImpersonation(BASE_INPUT)).rejects.toThrow(
      ForbiddenException,
    );
    // Rejection audit should have fired
    expect(audit.emitInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        kind: 'IMPERSONATION_START_REJECTED',
        payload: expect.objectContaining({ rejectReason: 'TARGET_DIFFERENT_TENANT' }),
      }),
    );
  });

  it('G — throws 409 when a non-expired grant already exists', async () => {
    const client = makeClient();
    (client.query as ReturnType<typeof vi.fn>).mockResolvedValue({
      rows: [],
      rowCount: 0,
    });
    const pool = makePool(AGENCY_ACCOUNT, client);
    // findUnendedByActor returns an active (non-expired) grant
    const grantRepo = makeGrantRepo({
      findUnendedByActor: vi.fn(async () => ACTIVE_GRANT),
    });
    const audit = makeAudit();
    const svc = makeService(pool, grantRepo, audit);

    await expect(svc.startImpersonation(BASE_INPUT)).rejects.toThrow(
      ConflictException,
    );
    // Insert must NOT have been called
    expect(grantRepo.insert).not.toHaveBeenCalled();
    // Rejection audit fires
    expect(audit.emitInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        kind: 'IMPERSONATION_START_REJECTED',
        payload: expect.objectContaining({ rejectReason: 'ACTIVE_GRANT_EXISTS' }),
      }),
    );
  });

  it('H — auto-ends an expired un-ended grant and inserts new grant', async () => {
    const client = makeClient();
    (client.query as ReturnType<typeof vi.fn>).mockResolvedValue({
      rows: [],
      rowCount: 0,
    });
    const pool = makePool(AGENCY_ACCOUNT, client);
    const grantRepo = makeGrantRepo({
      findUnendedByActor: vi.fn(async () => EXPIRED_GRANT),
    });
    const audit = makeAudit();
    const svc = makeService(pool, grantRepo, audit);

    const result = await svc.startImpersonation(BASE_INPUT);

    expect(result.grantId).toBe(ACTIVE_GRANT.id);
    // expired grant ended first
    expect(grantRepo.end).toHaveBeenCalledWith(
      client,
      expect.objectContaining({ endedReason: 'EXPIRED' }),
    );
    // IMPERSONATION_ENDED for the expired grant
    expect(audit.emitInTransaction).toHaveBeenCalledWith(
      client,
      expect.objectContaining({ kind: 'IMPERSONATION_ENDED' }),
    );
    // Then IMPERSONATION_STARTED for the new grant
    expect(audit.emitInTransaction).toHaveBeenCalledWith(
      client,
      expect.objectContaining({ kind: 'IMPERSONATION_STARTED' }),
    );
  });
});

describe('ImpersonationService.stopImpersonation', () => {
  it('I — ends the active grant, emits IMPERSONATION_ENDED, returns ended=true', async () => {
    const client = makeClient();
    (client.query as ReturnType<typeof vi.fn>).mockResolvedValue({
      rows: [],
      rowCount: 0,
    });
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
    const grantRepo = makeGrantRepo({
      end: vi.fn(async () => ({ rowsUpdated: 1, grantId: GRANT_ID })),
    });
    const audit = makeAudit();
    const svc = makeService(pool, grantRepo, audit);

    const result = await svc.stopImpersonation(ACTOR_ID, TENANT_ID);

    expect(result.ended).toBe(true);
    expect(audit.emitInTransaction).toHaveBeenCalledWith(
      client,
      expect.objectContaining({
        category: 'IMPERSONATION',
        kind: 'IMPERSONATION_ENDED',
        payload: expect.objectContaining({ endReason: 'REQUEST_END' }),
      }),
    );
  });

  it('J — returns ended=false and does not emit when no active grant', async () => {
    const client = makeClient();
    (client.query as ReturnType<typeof vi.fn>).mockResolvedValue({
      rows: [],
      rowCount: 0,
    });
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
    const grantRepo = makeGrantRepo({
      end: vi.fn(async () => ({ rowsUpdated: 0, grantId: null })),
    });
    const audit = makeAudit();
    const svc = makeService(pool, grantRepo, audit);

    const result = await svc.stopImpersonation(ACTOR_ID, TENANT_ID);

    expect(result.ended).toBe(false);
    expect(audit.emitInTransaction).not.toHaveBeenCalled();
  });
});

describe('ImpersonationService.getActiveGrant', () => {
  it('K — delegates to grantRepo.findActiveByActor', async () => {
    const pool = makePool();
    const grantRepo = makeGrantRepo({
      findActiveByActor: vi.fn(async () => ACTIVE_GRANT),
    });
    const svc = makeService(pool, grantRepo, makeAudit());

    const grant = await svc.getActiveGrant(ACTOR_ID);
    expect(grant?.id).toBe(GRANT_ID);
    expect(grantRepo.findActiveByActor).toHaveBeenCalledWith(pool, ACTOR_ID);
  });

  it('L — returns null when no active grant', async () => {
    const pool = makePool();
    const grantRepo = makeGrantRepo({
      findActiveByActor: vi.fn(async () => null),
    });
    const svc = makeService(pool, grantRepo, makeAudit());

    expect(await svc.getActiveGrant(ACTOR_ID)).toBeNull();
  });
});

// ── parseTtlMinutes ──────────────────────────────────────────────────────────

describe('parseTtlMinutes', () => {
  it('M — returns 30 (default) when env is undefined', () => {
    expect(parseTtlMinutes(undefined)).toBe(30);
  });

  it('N — returns 30 (default) when env is empty or blank string', () => {
    expect(parseTtlMinutes('')).toBe(30);
    expect(parseTtlMinutes('   ')).toBe(30);
  });

  it('O — returns parsed value for valid in-range numbers', () => {
    expect(parseTtlMinutes('5')).toBe(5);
    expect(parseTtlMinutes('60')).toBe(60);
    expect(parseTtlMinutes('240')).toBe(240);
  });

  it('P — throws for non-numeric values', () => {
    expect(() => parseTtlMinutes('abc')).toThrow(
      /IMPERSONATION_TTL_MINUTES must be a valid number/,
    );
    expect(() => parseTtlMinutes('NaN')).toThrow();
    expect(() => parseTtlMinutes('Infinity')).toThrow();
  });

  it('Q — throws when value is below minimum (5)', () => {
    expect(() => parseTtlMinutes('4')).toThrow(
      /IMPERSONATION_TTL_MINUTES must be between 5 and 240/,
    );
    expect(() => parseTtlMinutes('0')).toThrow();
    expect(() => parseTtlMinutes('-10')).toThrow();
  });

  it('R — throws when value exceeds maximum (240)', () => {
    expect(() => parseTtlMinutes('241')).toThrow(
      /IMPERSONATION_TTL_MINUTES must be between 5 and 240/,
    );
    expect(() => parseTtlMinutes('999')).toThrow();
  });
});
