import { describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from '@bb/db';
import {
  EmailAlreadyTakenError,
  InvalidProvisioningRequest,
  MembershipAlreadyExistsError,
  UserProvisioningService,
} from '../management/user-provisioning.service';
import {
  Auth0ManagementError,
  type Auth0ManagementClient,
} from '../management/auth0-management.client';
import type { CoreUserRepository } from '../user-sync/user.repository';
import type { UserRoleRepository } from '../permissions/user-role.repository';
import type { UserAccountMembershipRepository } from '../permissions/user-account-membership.repository';

/**
 * Pure unit tests. Repositories and the Management API client are
 * fully mocked. The contract under test:
 *
 *   - operator vs agency class coherence
 *   - the same DB transaction holds core_user, role, and (for agency)
 *     membership inserts
 *   - 409 from Auth0 → EmailAlreadyTakenError, no DB transaction starts
 *   - DB failure after Auth0 createUser → compensating Auth0 delete
 *   - membership unique_violation → MembershipAlreadyExistsError
 */

const TENANT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const ACCOUNT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAC';
const GRANTED_BY = '01ARZ3NDEKTSV4RRFFQ69G5GRA';

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

function makeMgmt(): {
  mgmt: Auth0ManagementClient;
  createUser: ReturnType<typeof vi.fn>;
  deleteUser: ReturnType<typeof vi.fn>;
} {
  const createUser = vi.fn(async () => ({ user_id: 'auth0|new' }));
  const deleteUser = vi.fn(async () => undefined);
  return {
    mgmt: { createUser, deleteUser } as unknown as Auth0ManagementClient,
    createUser,
    deleteUser,
  };
}

function makeUsers(): {
  users: CoreUserRepository;
  insertProvisioned: ReturnType<typeof vi.fn>;
} {
  const insertProvisioned = vi.fn(async (_q, input) => ({
    id: '01ARZ3NDEKTSV4RRFFQ69G5USR',
    tenantId: input.tenantId,
    auth0Sub: input.auth0Sub,
    email: input.email,
    displayName: input.displayName ?? null,
    userClass: input.userClass,
    status: 'ACTIVE',
  }));
  return {
    users: { insertProvisioned } as unknown as CoreUserRepository,
    insertProvisioned,
  };
}

function makeRoles(): {
  roles: UserRoleRepository;
  insert: ReturnType<typeof vi.fn>;
} {
  const insert = vi.fn(async (_q, input) => ({ id: input.id }));
  return { roles: { insert } as unknown as UserRoleRepository, insert };
}

function makeMemberships(): {
  memberships: UserAccountMembershipRepository;
  insert: ReturnType<typeof vi.fn>;
} {
  const insert = vi.fn(async (_q, input) => ({ id: input.id }));
  return {
    memberships: { insert } as unknown as UserAccountMembershipRepository,
    insert,
  };
}

describe('UserProvisioningService.provisionOperator', () => {
  it('creates Auth0 user, then DB rows in a transaction with role grant', async () => {
    const { pool, clients } = makePool();
    const m = makeMgmt();
    const u = makeUsers();
    const r = makeRoles();
    const mb = makeMemberships();
    const svc = new UserProvisioningService(pool, m.mgmt, u.users, r.roles, mb.memberships);

    const result = await svc.provisionOperator({
      tenantId: TENANT_ID,
      email: 'ops@beyondborders.test',
      displayName: 'Ops Person',
      grantedBy: GRANTED_BY,
      roles: ['ops_support'],
    });

    expect(result.auth0UserId).toBe('auth0|new');
    expect(m.createUser).toHaveBeenCalledTimes(1);
    expect(m.deleteUser).not.toHaveBeenCalled();
    expect(u.insertProvisioned).toHaveBeenCalledTimes(1);
    expect(r.insert).toHaveBeenCalledTimes(1);
    expect(mb.insert).not.toHaveBeenCalled();

    // Single client used; BEGIN + COMMIT issued; client released.
    expect(clients).toHaveLength(1);
    const queries = clients[0]!.query.mock.calls.map((c) => c[0]);
    expect(queries).toContain('BEGIN');
    expect(queries).toContain('COMMIT');
    expect(clients[0]!.release).toHaveBeenCalledTimes(1);
  });

  it('rejects empty role list', async () => {
    const svc = makeService();
    await expect(
      svc.provisionOperator({
        tenantId: TENANT_ID,
        email: 'x@y.z',
        grantedBy: GRANTED_BY,
        roles: [],
      }),
    ).rejects.toThrow(InvalidProvisioningRequest);
  });

  it('rejects agency role on operator path (class coherence)', async () => {
    const svc = makeService();
    await expect(
      svc.provisionOperator({
        tenantId: TENANT_ID,
        email: 'x@y.z',
        grantedBy: GRANTED_BY,
        roles: ['account_admin'] as never,
      }),
    ).rejects.toThrow(InvalidProvisioningRequest);
  });
});

describe('UserProvisioningService.provisionAgencyUser', () => {
  it('writes core_user + membership + role in the same transaction', async () => {
    const { pool, clients } = makePool();
    const m = makeMgmt();
    const u = makeUsers();
    const r = makeRoles();
    const mb = makeMemberships();
    const svc = new UserProvisioningService(pool, m.mgmt, u.users, r.roles, mb.memberships);

    await svc.provisionAgencyUser({
      tenantId: TENANT_ID,
      email: 'agent@agency.test',
      accountId: ACCOUNT_ID,
      grantedBy: GRANTED_BY,
      roles: ['account_admin'],
    });

    expect(m.createUser).toHaveBeenCalledTimes(1);
    expect(u.insertProvisioned).toHaveBeenCalledTimes(1);
    expect(mb.insert).toHaveBeenCalledTimes(1);
    expect(mb.insert.mock.calls[0]![1]).toMatchObject({
      userId: '01ARZ3NDEKTSV4RRFFQ69G5USR',
      accountId: ACCOUNT_ID,
    });
    expect(r.insert).toHaveBeenCalledTimes(1);

    // All three writes happened against the same client (one BEGIN, one COMMIT).
    expect(clients).toHaveLength(1);
    expect(u.insertProvisioned.mock.calls[0]![0]).toBe(clients[0]!.client);
    expect(mb.insert.mock.calls[0]![0]).toBe(clients[0]!.client);
    expect(r.insert.mock.calls[0]![0]).toBe(clients[0]!.client);
  });

  it('rejects missing accountId', async () => {
    const svc = makeService();
    await expect(
      svc.provisionAgencyUser({
        tenantId: TENANT_ID,
        email: 'x@y.z',
        accountId: '' as unknown as string,
        grantedBy: GRANTED_BY,
        roles: ['account_admin'],
      }),
    ).rejects.toThrow(/accountId/);
  });

  it('rejects operator role on agency path', async () => {
    const svc = makeService();
    await expect(
      svc.provisionAgencyUser({
        tenantId: TENANT_ID,
        email: 'x@y.z',
        accountId: ACCOUNT_ID,
        grantedBy: GRANTED_BY,
        roles: ['platform_admin'] as never,
      }),
    ).rejects.toThrow(InvalidProvisioningRequest);
  });

  it('translates membership unique_violation', async () => {
    const { pool } = makePool();
    const m = makeMgmt();
    const u = makeUsers();
    const r = makeRoles();
    const mb = makeMemberships();
    mb.insert.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }));
    const svc = new UserProvisioningService(pool, m.mgmt, u.users, r.roles, mb.memberships);

    await expect(
      svc.provisionAgencyUser({
        tenantId: TENANT_ID,
        email: 'x@y.z',
        accountId: ACCOUNT_ID,
        grantedBy: GRANTED_BY,
        roles: ['booker'],
      }),
    ).rejects.toThrow(MembershipAlreadyExistsError);

    // Compensating delete invoked because the DB transaction failed.
    expect(m.deleteUser).toHaveBeenCalledWith('auth0|new');
  });
});

describe('UserProvisioningService — Auth0 / DB error paths', () => {
  it('translates Auth0 409 into EmailAlreadyTakenError without touching the DB', async () => {
    const { pool, clients } = makePool();
    const m = makeMgmt();
    m.createUser.mockRejectedValueOnce(
      new Auth0ManagementError(409, 'auth0_idp_error', 'already exists'),
    );
    const u = makeUsers();
    const r = makeRoles();
    const mb = makeMemberships();
    const svc = new UserProvisioningService(pool, m.mgmt, u.users, r.roles, mb.memberships);

    await expect(
      svc.provisionOperator({
        tenantId: TENANT_ID,
        email: 'dup@y.z',
        grantedBy: GRANTED_BY,
        roles: ['ops_support'],
      }),
    ).rejects.toThrow(EmailAlreadyTakenError);
    expect(clients).toHaveLength(0);
    expect(m.deleteUser).not.toHaveBeenCalled();
  });

  it('compensates by deleting the Auth0 user on DB transaction failure', async () => {
    const { pool, clients } = makePool();
    const m = makeMgmt();
    const u = makeUsers();
    u.insertProvisioned.mockRejectedValueOnce(new Error('db down'));
    const r = makeRoles();
    const mb = makeMemberships();
    const svc = new UserProvisioningService(pool, m.mgmt, u.users, r.roles, mb.memberships);

    await expect(
      svc.provisionOperator({
        tenantId: TENANT_ID,
        email: 'x@y.z',
        grantedBy: GRANTED_BY,
        roles: ['ops_support'],
      }),
    ).rejects.toThrow(/db down/);
    expect(m.deleteUser).toHaveBeenCalledWith('auth0|new');
    // Transaction was rolled back.
    const queries = clients[0]!.query.mock.calls.map((c) => c[0]);
    expect(queries).toContain('ROLLBACK');
  });

  it('does not throw if compensating delete fails — original error wins', async () => {
    const { pool } = makePool();
    const m = makeMgmt();
    const u = makeUsers();
    u.insertProvisioned.mockRejectedValueOnce(new Error('db down'));
    m.deleteUser.mockRejectedValueOnce(new Error('compensate fail'));
    const r = makeRoles();
    const mb = makeMemberships();
    const svc = new UserProvisioningService(pool, m.mgmt, u.users, r.roles, mb.memberships);

    await expect(
      svc.provisionOperator({
        tenantId: TENANT_ID,
        email: 'x@y.z',
        grantedBy: GRANTED_BY,
        roles: ['ops_support'],
      }),
    ).rejects.toThrow(/db down/);
  });

  it('throws when Auth0 createUser returns no user_id', async () => {
    const { pool, clients } = makePool();
    const m = makeMgmt();
    m.createUser.mockResolvedValueOnce({} as never);
    const u = makeUsers();
    const r = makeRoles();
    const mb = makeMemberships();
    const svc = new UserProvisioningService(pool, m.mgmt, u.users, r.roles, mb.memberships);

    await expect(
      svc.provisionOperator({
        tenantId: TENANT_ID,
        email: 'x@y.z',
        grantedBy: GRANTED_BY,
        roles: ['ops_support'],
      }),
    ).rejects.toThrow(/no user_id/);
    // No DB tx attempted.
    expect(clients).toHaveLength(0);
  });
});

function makeService(): UserProvisioningService {
  const { pool } = makePool();
  const m = makeMgmt();
  const u = makeUsers();
  const r = makeRoles();
  const mb = makeMemberships();
  return new UserProvisioningService(pool, m.mgmt, u.users, r.roles, mb.memberships);
}
