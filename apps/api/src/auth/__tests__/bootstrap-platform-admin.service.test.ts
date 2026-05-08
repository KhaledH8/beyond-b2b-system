import { describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from '@bb/db';
import { BootstrapPlatformAdminService } from '../bootstrap/bootstrap-platform-admin.service';
import type {
  CoreUserRecord,
  CoreUserRepository,
} from '../user-sync/user.repository';
import type { UserRoleRepository } from '../permissions/user-role.repository';

/**
 * Pure unit tests. Repositories mocked; the contract under test is
 * idempotency:
 *
 *   - cold path inserts core_user + role grant, returns
 *     { created: true, roleGranted: true }.
 *   - re-running with the same auth0Sub returns
 *     { created: false, roleGranted: false } and writes nothing.
 *   - DEACTIVATED row is reactivated.
 *   - if the row exists but the platform_admin grant does not, the
 *     grant is added without reinserting the user.
 */

const TENANT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const USER_ID = '01ARZ3NDEKTSV4RRFFQ69G5FBA';

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

function makeUsers(initial: {
  existing?: CoreUserRecord;
  inserted?: CoreUserRecord;
}): {
  users: CoreUserRepository;
  findByAuth0Sub: ReturnType<typeof vi.fn>;
  insertProvisioned: ReturnType<typeof vi.fn>;
  setStatus: ReturnType<typeof vi.fn>;
} {
  const findByAuth0Sub = vi.fn(async () => initial.existing);
  const insertProvisioned = vi.fn(async () => initial.inserted ?? FRESH_RECORD);
  const setStatus = vi.fn(async () => true);
  return {
    users: { findByAuth0Sub, insertProvisioned, setStatus } as unknown as CoreUserRepository,
    findByAuth0Sub,
    insertProvisioned,
    setStatus,
  };
}

function makeRoles(initialActive: string[]): {
  roles: UserRoleRepository;
  findActiveRolesForUser: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
} {
  const findActiveRolesForUser = vi.fn(async () => initialActive);
  const insert = vi.fn(async () => ({ id: 'newRoleUlid' }));
  return {
    roles: { findActiveRolesForUser, insert } as unknown as UserRoleRepository,
    findActiveRolesForUser,
    insert,
  };
}

const FRESH_RECORD: CoreUserRecord = {
  id: USER_ID,
  tenantId: TENANT_ID,
  auth0Sub: 'auth0|admin',
  email: 'admin@beyondborders.test',
  displayName: 'Admin Person',
  userClass: 'OPERATOR',
  status: 'ACTIVE',
};

describe('BootstrapPlatformAdminService.ensure', () => {
  it('cold path creates the user and grants platform_admin', async () => {
    const { pool, clients } = makePool();
    const u = makeUsers({});
    const r = makeRoles([]);
    const svc = new BootstrapPlatformAdminService(pool, u.users, r.roles);

    const result = await svc.ensure({
      auth0Sub: 'auth0|admin',
      email: 'admin@beyondborders.test',
      tenantId: TENANT_ID,
      displayName: 'Admin Person',
    });

    expect(result).toEqual({
      userId: USER_ID,
      created: true,
      roleGranted: true,
    });
    expect(u.insertProvisioned).toHaveBeenCalledTimes(1);
    expect(r.insert).toHaveBeenCalledTimes(1);
    expect(r.insert.mock.calls[0]![1]).toMatchObject({
      userId: USER_ID,
      role: 'platform_admin',
      grantedBy: null,
    });
    // BEGIN/COMMIT happened on a single client.
    const queries = clients[0]!.query.mock.calls.map((c) => c[0]);
    expect(queries).toContain('BEGIN');
    expect(queries).toContain('COMMIT');
  });

  it('idempotent re-run — user exists and grant exists', async () => {
    const { pool } = makePool();
    const u = makeUsers({ existing: FRESH_RECORD });
    const r = makeRoles(['platform_admin']);
    const svc = new BootstrapPlatformAdminService(pool, u.users, r.roles);

    const result = await svc.ensure({
      auth0Sub: 'auth0|admin',
      email: 'admin@beyondborders.test',
      tenantId: TENANT_ID,
    });

    expect(result).toEqual({
      userId: USER_ID,
      created: false,
      roleGranted: false,
    });
    expect(u.insertProvisioned).not.toHaveBeenCalled();
    expect(r.insert).not.toHaveBeenCalled();
    expect(u.setStatus).not.toHaveBeenCalled();
  });

  it('re-activates a DEACTIVATED row', async () => {
    const { pool } = makePool();
    const u = makeUsers({
      existing: { ...FRESH_RECORD, status: 'DEACTIVATED' },
    });
    const r = makeRoles([]);
    const svc = new BootstrapPlatformAdminService(pool, u.users, r.roles);

    const result = await svc.ensure({
      auth0Sub: 'auth0|admin',
      email: 'admin@beyondborders.test',
      tenantId: TENANT_ID,
    });
    expect(u.setStatus).toHaveBeenCalledWith(
      expect.anything(),
      'auth0|admin',
      'ACTIVE',
    );
    expect(result.created).toBe(false);
    expect(result.roleGranted).toBe(true);
  });

  it('grants platform_admin if user exists without it', async () => {
    const { pool } = makePool();
    const u = makeUsers({ existing: FRESH_RECORD });
    const r = makeRoles(['ops_support']); // some other role
    const svc = new BootstrapPlatformAdminService(pool, u.users, r.roles);

    const result = await svc.ensure({
      auth0Sub: 'auth0|admin',
      email: 'admin@beyondborders.test',
      tenantId: TENANT_ID,
    });
    expect(result.created).toBe(false);
    expect(result.roleGranted).toBe(true);
    expect(r.insert).toHaveBeenCalledTimes(1);
  });

  it('rejects calls missing required arguments', async () => {
    const { pool } = makePool();
    const svc = new BootstrapPlatformAdminService(
      pool,
      makeUsers({}).users,
      makeRoles([]).roles,
    );
    await expect(
      svc.ensure({
        auth0Sub: '',
        email: 'a@b.c',
        tenantId: TENANT_ID,
      }),
    ).rejects.toThrow();
  });

  it('rolls back on unexpected error', async () => {
    const { pool, clients } = makePool();
    const u = makeUsers({});
    u.insertProvisioned.mockRejectedValueOnce(new Error('db down'));
    const r = makeRoles([]);
    const svc = new BootstrapPlatformAdminService(pool, u.users, r.roles);

    await expect(
      svc.ensure({
        auth0Sub: 'auth0|admin',
        email: 'a@b.c',
        tenantId: TENANT_ID,
      }),
    ).rejects.toThrow(/db down/);
    const queries = clients[0]!.query.mock.calls.map((c) => c[0]);
    expect(queries).toContain('ROLLBACK');
  });
});
