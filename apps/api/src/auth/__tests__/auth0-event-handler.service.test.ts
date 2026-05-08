import { describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from '@bb/db';
import { Auth0EventHandlerService } from '../webhook/auth0-event-handler.service';
import type { CoreUserRepository } from '../user-sync/user.repository';
import type { Auth0EventIngestionRepository } from '../webhook/auth0-event-ingestion.repository';

/**
 * Verifies:
 *
 *   - Each entry runs in its own transaction (BEGIN+COMMIT or
 *     BEGIN+ROLLBACK) on a freshly checked-out client.
 *   - Duplicate log_id (ledger returns false) → no side-effect, no
 *     additional repo calls.
 *   - sce/scu update email; scn updates display_name; sd deactivates;
 *     sapi-Block / sapi-Unblock flip status.
 *   - Unknown / well-formed events: ledger row written, no
 *     side-effect.
 *   - A single bad entry does not abort the rest of the batch.
 */

interface ClientMock {
  client: PoolClient;
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
}

function makePool(): { pool: Pool; clients: ClientMock[] } {
  const clients: ClientMock[] = [];
  const pool = {
    connect: vi.fn(async () => {
      const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
      const release = vi.fn();
      const client = { query, release } as unknown as PoolClient;
      const entry = { client, query, release };
      clients.push(entry);
      return client;
    }),
  } as unknown as Pool;
  return { pool, clients };
}

function makeUsers(): {
  users: CoreUserRepository;
  updateProfile: ReturnType<typeof vi.fn>;
  setStatus: ReturnType<typeof vi.fn>;
} {
  const updateProfile = vi.fn(async () => true);
  const setStatus = vi.fn(async () => true);
  return {
    users: { updateProfile, setStatus } as unknown as CoreUserRepository,
    updateProfile,
    setStatus,
  };
}

function makeLedger(record: (logId: string) => boolean): {
  ledger: Auth0EventIngestionRepository;
  tryRecord: ReturnType<typeof vi.fn>;
} {
  const tryRecord = vi.fn(async (_q, logId: string) => record(logId));
  return {
    ledger: { tryRecord } as unknown as Auth0EventIngestionRepository,
    tryRecord,
  };
}

describe('Auth0EventHandlerService', () => {
  it('applies an `sce` event by updating email', async () => {
    const { pool } = makePool();
    const u = makeUsers();
    const l = makeLedger(() => true);
    const svc = new Auth0EventHandlerService(pool, u.users, l.ledger);

    const summary = await svc.handleBatch({
      logs: [
        {
          log_id: 'log_001',
          type: 'sce',
          user_id: 'auth0|abc',
          newEmail: 'updated@beyondborders.test',
        },
      ],
    });
    expect(summary).toMatchObject({ received: 1, applied: 1, duplicates: 0 });
    expect(u.updateProfile).toHaveBeenCalledWith(
      expect.anything(),
      'auth0|abc',
      { email: 'updated@beyondborders.test' },
    );
  });

  it('applies an `scn` event by updating display_name', async () => {
    const { pool } = makePool();
    const u = makeUsers();
    const l = makeLedger(() => true);
    const svc = new Auth0EventHandlerService(pool, u.users, l.ledger);

    await svc.handleBatch([
      {
        log_id: 'log_002',
        type: 'scn',
        user_id: 'auth0|abc',
        newName: 'New Name',
      },
    ]);
    expect(u.updateProfile).toHaveBeenCalledWith(
      expect.anything(),
      'auth0|abc',
      { displayName: 'New Name' },
    );
  });

  it('applies an `sd` event by deactivating the user', async () => {
    const { pool } = makePool();
    const u = makeUsers();
    const l = makeLedger(() => true);
    const svc = new Auth0EventHandlerService(pool, u.users, l.ledger);

    await svc.handleBatch([
      { log_id: 'log_003', type: 'sd', user_id: 'auth0|abc' },
    ]);
    expect(u.setStatus).toHaveBeenCalledWith(
      expect.anything(),
      'auth0|abc',
      'DEACTIVATED',
    );
  });

  it('handles `sapi` Block User and Unblock User by flipping status', async () => {
    const { pool } = makePool();
    const u = makeUsers();
    const l = makeLedger(() => true);
    const svc = new Auth0EventHandlerService(pool, u.users, l.ledger);

    await svc.handleBatch([
      {
        log_id: 'log_blk',
        type: 'sapi',
        user_id: 'auth0|abc',
        description: 'Block User',
      },
      {
        log_id: 'log_unblk',
        type: 'sapi',
        user_id: 'auth0|abc',
        description: 'Unblock User',
      },
    ]);

    expect(u.setStatus.mock.calls).toEqual([
      [expect.anything(), 'auth0|abc', 'DEACTIVATED'],
      [expect.anything(), 'auth0|abc', 'ACTIVE'],
    ]);
  });

  it('skips processing on duplicate log_id and counts it as duplicate', async () => {
    const { pool } = makePool();
    const u = makeUsers();
    const l = makeLedger(() => false); // ledger reports already-seen
    const svc = new Auth0EventHandlerService(pool, u.users, l.ledger);

    const summary = await svc.handleBatch([
      { log_id: 'dup', type: 'sd', user_id: 'auth0|abc' },
    ]);
    expect(summary).toMatchObject({ received: 1, duplicates: 1, applied: 0 });
    expect(u.setStatus).not.toHaveBeenCalled();
  });

  it('records ledger row for unknown event types but does not call user updates', async () => {
    const { pool } = makePool();
    const u = makeUsers();
    const l = makeLedger(() => true);
    const svc = new Auth0EventHandlerService(pool, u.users, l.ledger);

    const summary = await svc.handleBatch([
      { log_id: 'log_unknown', type: 'fco', user_id: 'auth0|abc' }, // failed login etc
    ]);
    expect(l.tryRecord).toHaveBeenCalledTimes(1);
    expect(u.updateProfile).not.toHaveBeenCalled();
    expect(u.setStatus).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ received: 1, skipped: 1, applied: 0 });
  });

  it('processes each entry in its own transaction', async () => {
    const { pool, clients } = makePool();
    const u = makeUsers();
    const l = makeLedger(() => true);
    const svc = new Auth0EventHandlerService(pool, u.users, l.ledger);

    await svc.handleBatch([
      { log_id: 'a', type: 'sd', user_id: 'auth0|x' },
      { log_id: 'b', type: 'sd', user_id: 'auth0|y' },
    ]);
    expect(clients).toHaveLength(2);
    for (const c of clients) {
      const calls = c.query.mock.calls.map((args) => args[0]);
      expect(calls).toContain('BEGIN');
      expect(calls).toContain('COMMIT');
      expect(c.release).toHaveBeenCalledTimes(1);
    }
  });

  it('isolates a malformed entry from siblings (rest of batch still processed)', async () => {
    const { pool } = makePool();
    const u = makeUsers();
    const l = makeLedger(() => true);
    const svc = new Auth0EventHandlerService(pool, u.users, l.ledger);

    const summary = await svc.handleBatch([
      { type: 'sd', user_id: 'auth0|x' }, // missing log_id → malformed
      { log_id: 'good', type: 'sd', user_id: 'auth0|y' },
    ]);
    expect(summary.received).toBe(2);
    expect(summary.malformed).toBe(1);
    expect(summary.applied).toBe(1);
    expect(u.setStatus).toHaveBeenCalledWith(
      expect.anything(),
      'auth0|y',
      'DEACTIVATED',
    );
  });

  it('extracts user_id from `data` when not present at the top level', async () => {
    const { pool } = makePool();
    const u = makeUsers();
    const l = makeLedger(() => true);
    const svc = new Auth0EventHandlerService(pool, u.users, l.ledger);

    await svc.handleBatch([
      {
        log_id: 'log_data',
        type: 'sd',
        data: { user_id: 'auth0|nested' },
      },
    ]);
    expect(u.setStatus).toHaveBeenCalledWith(
      expect.anything(),
      'auth0|nested',
      'DEACTIVATED',
    );
  });

  it('returns 0 received for empty / non-array payload shapes', async () => {
    const { pool } = makePool();
    const u = makeUsers();
    const l = makeLedger(() => true);
    const svc = new Auth0EventHandlerService(pool, u.users, l.ledger);

    expect(await svc.handleBatch(null)).toMatchObject({ received: 0 });
    expect(await svc.handleBatch({})).toMatchObject({ received: 1 });
    expect(await svc.handleBatch({ logs: [] })).toMatchObject({ received: 0 });
  });
});
