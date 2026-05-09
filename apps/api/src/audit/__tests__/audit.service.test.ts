import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool, PoolClient } from '@bb/db';
import { AuditService } from '../audit.service';
import { requestContextStore } from '../request-context';
import type { AuditEventInput, AuditEventInputBackground } from '../audit-event.types';

/**
 * Unit tests for AuditService (ADR-028 D7).
 *
 * Verifies:
 *   A) Category emission rules — compile-time restrictions and runtime
 *      guard for background emit().
 *   B) emit() swallows DB errors; emitInTransaction() propagates them.
 *   C) Request context propagation — requestId and actor fields are
 *      read from AsyncLocalStorage and stamped on the INSERT.
 *   D) emitMany() iterates over a batch.
 *
 * The PG_POOL is mocked structurally. No real DB connection is needed.
 */

function makeMockPool(queryFn = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })): Pool {
  return { query: queryFn } as unknown as Pool;
}

function makeMockClient(queryFn = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })): PoolClient {
  return { query: queryFn, release: vi.fn() } as unknown as PoolClient;
}

const APP_EVENT: AuditEventInputBackground = {
  category: 'APP',
  kind: 'BOOKING_CONFIRMED',
  tenantId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  targetId: '01ARZ3NDEKTSV4RRFFQ69G5BOK',
  payload: { bookingId: '01ARZ3NDEKTSV4RRFFQ69G5BOK', supplierId: 'hotelbeds' },
};

const SECURITY_EVENT: AuditEventInputBackground = {
  category: 'SECURITY',
  kind: 'WEBHOOK_SIGNATURE_FAILED',
  tenantId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  payload: { source: 'auth0', headerPresent: false },
};

const AUTH_EVENT: AuditEventInput = {
  category: 'AUTH',
  kind: 'USER_PROVISIONED',
  tenantId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  targetId: '01ARZ3NDEKTSV4RRFFQ69G5USR',
  payload: { auth0Sub: 'auth0|x', userClass: 'AGENCY', email: 'a@b.com' },
};

const IMPERSONATION_EVENT: AuditEventInput = {
  category: 'IMPERSONATION',
  kind: 'IMPERSONATION_STARTED',
  tenantId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  targetId: '01ARZ3NDEKTSV4RRFFQ69G5GID',
  payload: {
    grantId: '01ARZ3NDEKTSV4RRFFQ69G5GID',
    targetAccountId: '01ARZ3NDEKTSV4RRFFQ69G5FAC',
    targetAccountName: 'Test Agency',
    targetAccountType: 'AGENCY',
    ticketRef: 'TICKET-123',
  },
};

// ── A) Category emission rules ────────────────────────────────────────

describe('AuditService.emit — category restriction', () => {
  let service: AuditService;
  let pool: Pool;

  beforeEach(() => {
    pool = makeMockPool();
    service = new AuditService(pool);
  });

  it('emits APP event via background path without throwing', async () => {
    await expect(service.emit(APP_EVENT)).resolves.toBeUndefined();
    expect((pool.query as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
  });

  it('emits SECURITY event via background path without throwing', async () => {
    await expect(service.emit(SECURITY_EVENT)).resolves.toBeUndefined();
    expect((pool.query as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
  });

  it('runtime guard throws when called with AUTH (defence in depth against type casts)', async () => {
    // TypeScript would reject this at compile time for typed callers.
    // The cast simulates a caller bypassing the type system.
    const authAsBackground = AUTH_EVENT as unknown as AuditEventInputBackground;
    await expect(service.emit(authAsBackground)).rejects.toThrow(
      /requires emitInTransaction/,
    );
    expect((pool.query as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('runtime guard throws when called with IMPERSONATION', async () => {
    const impAsBackground = IMPERSONATION_EVENT as unknown as AuditEventInputBackground;
    await expect(service.emit(impAsBackground)).rejects.toThrow(
      /requires emitInTransaction/,
    );
    expect((pool.query as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});

// ── B) Error behaviour ────────────────────────────────────────────────

describe('AuditService.emit — DB error handling', () => {
  it('swallows DB error and resolves (best-effort emit)', async () => {
    const pool = makeMockPool(vi.fn().mockRejectedValue(new Error('connection refused')));
    const service = new AuditService(pool);
    // Must not throw — business action succeeds even if audit write fails.
    await expect(service.emit(APP_EVENT)).resolves.toBeUndefined();
  });
});

describe('AuditService.emitInTransaction — DB error propagation', () => {
  it('propagates DB error so the enclosing transaction rolls back', async () => {
    const client = makeMockClient(
      vi.fn().mockRejectedValue(new Error('partition missing')),
    );
    const service = new AuditService(makeMockPool());
    await expect(service.emitInTransaction(client, AUTH_EVENT)).rejects.toThrow(
      'partition missing',
    );
  });

  it('accepts any category including AUTH and IMPERSONATION', async () => {
    const client = makeMockClient();
    const service = new AuditService(makeMockPool());

    await expect(service.emitInTransaction(client, AUTH_EVENT)).resolves.toBeUndefined();
    await expect(service.emitInTransaction(client, IMPERSONATION_EVENT)).resolves.toBeUndefined();
    expect((client.query as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2);
  });
});

// ── C) Request context propagation ────────────────────────────────────

describe('AuditService — request context stamping', () => {
  it('stamps requestId and actor from AsyncLocalStorage onto the INSERT', async () => {
    const queryFn = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const pool = makeMockPool(queryFn);
    const service = new AuditService(pool);

    const REQUEST_ID = '01ARZ3NDEKTSV4RRFFQ69G5RQI';
    const USER_ID    = '01ARZ3NDEKTSV4RRFFQ69G5USR';

    await requestContextStore.run(
      {
        requestId: REQUEST_ID,
        actorKind: 'USER',
        actorUserId: USER_ID,
        tenantId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        ipAddress: '192.168.1.1',
        userAgent: 'test-agent/1.0',
      },
      async () => {
        await service.emit(APP_EVENT);
      },
    );

    expect(queryFn).toHaveBeenCalledOnce();
    const [, params] = queryFn.mock.calls[0] as [string, unknown[]];

    // Params positional: $8=actorKind, $9=actorUserId, $14=requestId,
    // $16=ipAddress, $17=userAgent.
    expect(params![7]).toBe('USER');         // $8 actor_kind
    expect(params![8]).toBe(USER_ID);        // $9 actor_user_id
    expect(params![13]).toBe(REQUEST_ID);    // $14 request_id
    expect(params![15]).toBe('192.168.1.1'); // $16 ip_address (::inet cast in SQL)
    expect(params![16]).toBe('test-agent/1.0'); // $17 user_agent
  });

  it('falls back to ANONYMOUS actor when no context is active', async () => {
    const queryFn = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const service = new AuditService(makeMockPool(queryFn));

    // No requestContextStore.run() wrapper — simulates a cron / CLI caller.
    await service.emit(SECURITY_EVENT);

    const [, params] = queryFn.mock.calls[0] as [string, unknown[]];
    expect(params![7]).toBe('ANONYMOUS'); // $8 actor_kind
    expect(params![8]).toBeNull();        // $9 actor_user_id
    expect(params![13]).toBeNull();       // $14 request_id
  });
});

// ── D) emitMany ───────────────────────────────────────────────────────

describe('AuditService.emitMany', () => {
  it('calls emit for each event in the batch', async () => {
    const queryFn = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const service = new AuditService(makeMockPool(queryFn));

    await service.emitMany([APP_EVENT, SECURITY_EVENT]);
    expect(queryFn).toHaveBeenCalledTimes(2);
  });

  it('swallows individual errors and continues the batch', async () => {
    let callCount = 0;
    const queryFn = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.reject(new Error('first fails'));
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    const service = new AuditService(makeMockPool(queryFn));

    await expect(service.emitMany([APP_EVENT, SECURITY_EVENT])).resolves.toBeUndefined();
    expect(queryFn).toHaveBeenCalledTimes(2);
  });
});
