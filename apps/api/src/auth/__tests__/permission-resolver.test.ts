import { describe, expect, it, vi } from 'vitest';
import type { Pool } from '@bb/db';
import { PermissionResolverService } from '../permissions/permission-resolver.service';
import type { UserRoleRepository } from '../permissions/user-role.repository';
import type {
  UserAccountMembershipRecord,
  UserAccountMembershipRepository,
} from '../permissions/user-account-membership.repository';
import type { AuthContext } from '../auth-context';
import {
  IMPERSONATION_DENY_INITIAL,
  PERMISSION_KIND,
  PERMISSIONS,
  type Permission,
  type Role,
} from '../permissions/permissions';

/**
 * Pure unit tests for PermissionResolverService.
 *
 * Repositories are mocked structurally — no DB. The resolver's job
 * is to combine role grants + class + membership into a final
 * permission set, and the locked invariants (deny on missing
 * membership, deny on accountId mismatch) are pinned here.
 */

const fakePool = {} as unknown as Pool;

const TENANT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const USER_ID = '01ARZ3NDEKTSV4RRFFQ69G5FBA';
const ACCOUNT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAC';
const OTHER_ACCOUNT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAD';

function makeRoleRepo(roles: Role[]): UserRoleRepository {
  return {
    findActiveRolesForUser: vi.fn(async () => roles),
    findAllForUser: vi.fn(),
    insert: vi.fn(),
    revoke: vi.fn(),
  } as unknown as UserRoleRepository;
}

function makeMembershipRepo(
  membership: UserAccountMembershipRecord | undefined,
): UserAccountMembershipRepository {
  return {
    findActiveByUser: vi.fn(async () => membership),
    insert: vi.fn(),
  } as unknown as UserAccountMembershipRepository;
}

function operatorAuth(): AuthContext {
  return {
    auth0Sub: 'auth0|abc',
    userId: USER_ID,
    tenantId: TENANT_ID,
    accountId: null,
    userClass: 'OPERATOR',
  };
}

function agencyAuth(accountId = ACCOUNT_ID): AuthContext {
  return {
    auth0Sub: 'auth0|agent',
    userId: USER_ID,
    tenantId: TENANT_ID,
    accountId,
    userClass: 'AGENCY',
  };
}

const ACTIVE_MEMBERSHIP: UserAccountMembershipRecord = {
  id: '01ARZ3NDEKTSV4RRFFQ69G5MEM',
  userId: USER_ID,
  accountId: ACCOUNT_ID,
  status: 'ACTIVE',
};

describe('PermissionResolverService.resolve', () => {
  it('returns the union of permissions for an operator with multiple roles', async () => {
    const svc = new PermissionResolverService(
      fakePool,
      makeRoleRepo(['ops_support', 'finance_ops']),
      makeMembershipRepo(undefined),
    );
    const r = await svc.resolve(operatorAuth());
    expect(r.userClass).toBe('OPERATOR');
    expect(r.accountId).toBeNull();
    expect(r.roles).toEqual(['ops_support', 'finance_ops']);
    expect(r.permissions.has(PERMISSIONS.BOOKING_CANCEL_MANUAL)).toBe(true);
    expect(r.permissions.has(PERMISSIONS.LEDGER_ADJUST)).toBe(true);
  });

  it('returns empty permissions for an operator with no active grants (default deny)', async () => {
    const svc = new PermissionResolverService(
      fakePool,
      makeRoleRepo([]),
      makeMembershipRepo(undefined),
    );
    const r = await svc.resolve(operatorAuth());
    expect(r.permissions.size).toBe(0);
  });

  it('returns empty permissions for an AGENCY user with no active membership', async () => {
    const svc = new PermissionResolverService(
      fakePool,
      makeRoleRepo(['account_admin']),
      makeMembershipRepo(undefined),
    );
    const r = await svc.resolve(agencyAuth());
    expect(r.accountId).toBeNull();
    expect(r.permissions.size).toBe(0);
  });

  it('returns full permissions for an AGENCY user when membership matches token', async () => {
    const svc = new PermissionResolverService(
      fakePool,
      makeRoleRepo(['account_admin']),
      makeMembershipRepo(ACTIVE_MEMBERSHIP),
    );
    const r = await svc.resolve(agencyAuth(ACCOUNT_ID));
    expect(r.accountId).toBe(ACCOUNT_ID);
    expect(r.permissions.has(PERMISSIONS.USERS_MANAGE)).toBe(true);
    expect(r.permissions.has(PERMISSIONS.BOOKING_CREATE)).toBe(true);
  });

  it('denies all permissions when token accountId mismatches DB membership', async () => {
    const svc = new PermissionResolverService(
      fakePool,
      makeRoleRepo(['account_admin']),
      makeMembershipRepo(ACTIVE_MEMBERSHIP),
    );
    const r = await svc.resolve(agencyAuth(OTHER_ACCOUNT_ID));
    expect(r.accountId).toBe(ACCOUNT_ID); // db wins for the returned shape
    expect(r.permissions.size).toBe(0);
  });

  it('denies all permissions when an AGENCY token carries a null accountId', async () => {
    // V1 hardening: AGENCY tokens MUST carry account_id. The JWT
    // validator already rejects such tokens at the OIDC layer; the
    // resolver re-asserts it as defense in depth so an alternate
    // AuthContext-construction path can never silently succeed.
    const membershipRepo = makeMembershipRepo(ACTIVE_MEMBERSHIP);
    const svc = new PermissionResolverService(
      fakePool,
      makeRoleRepo(['booker']),
      membershipRepo,
    );
    const r = await svc.resolve(agencyAuth(null as unknown as string));
    expect(r.permissions.size).toBe(0);
    expect(r.accountId).toBeNull();
    // Membership lookup should be short-circuited — we deny before
    // touching the DB.
    expect(membershipRepo.findActiveByUser).not.toHaveBeenCalled();
  });

  it('still allows OPERATOR users with null accountId (only AGENCY is affected)', async () => {
    const svc = new PermissionResolverService(
      fakePool,
      makeRoleRepo(['ops_support']),
      makeMembershipRepo(undefined),
    );
    const r = await svc.resolve(operatorAuth());
    expect(r.accountId).toBeNull();
    expect(r.permissions.has(PERMISSIONS.BOOKING_CANCEL_MANUAL)).toBe(true);
  });

  it('silently ignores cross-class roles (defense in depth)', async () => {
    // OPERATOR user who somehow has an agency role grant in the DB.
    // The resolver expands only operator roles for OPERATOR class.
    const svc = new PermissionResolverService(
      fakePool,
      makeRoleRepo(['account_admin'] as unknown as Role[]),
      makeMembershipRepo(undefined),
    );
    const r = await svc.resolve(operatorAuth());
    expect(r.permissions.size).toBe(0);
  });
});

// ── Impersonation branch (ADR-027 D7) ───────────────────────────────────────

const GRANT_ID  = '01ARZ3NDEKTSV4RRFFQ69G5GRA';

function impersonatingAuth(accountId = ACCOUNT_ID): AuthContext {
  return {
    auth0Sub: 'auth0|op',
    userId: USER_ID,
    tenantId: TENANT_ID,
    accountId,
    userClass: 'AGENCY', // flipped by JwtAuthGuard during impersonation
    impersonation: {
      grantId: GRANT_ID,
      actorUserId: USER_ID,
      actorAuth0Sub: 'auth0|op',
      actorUserClass: 'OPERATOR',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      scope: 'READ_ONLY',
    },
  };
}

describe('PermissionResolverService — impersonation branch (ADR-027 D7)', () => {
  it('returns only READ permissions from agency/account_admin during impersonation', async () => {
    const svc = new PermissionResolverService(
      fakePool,
      makeRoleRepo([]), // operator roles are bypassed — should not be queried
      makeMembershipRepo(undefined),
    );
    const r = await svc.resolve(impersonatingAuth());

    // All returned permissions must be READ-classified
    for (const p of r.permissions) {
      if (p === PERMISSIONS.IMPERSONATE_AGENCY_ACCOUNT) continue; // explicit add
      expect(PERMISSION_KIND[p as Permission]).toBe('READ');
    }
    // userClass is AGENCY (as set by JwtAuthGuard)
    expect(r.userClass).toBe('AGENCY');
  });

  it('filters out WRITE permissions during impersonation', async () => {
    const svc = new PermissionResolverService(
      fakePool,
      makeRoleRepo([]),
      makeMembershipRepo(undefined),
    );
    const r = await svc.resolve(impersonatingAuth());

    expect(r.permissions.has(PERMISSIONS.BOOKING_CREATE)).toBe(false);
    expect(r.permissions.has(PERMISSIONS.BOOKING_CANCEL_OWN_WITHIN_POLICY)).toBe(false);
    expect(r.permissions.has(PERMISSIONS.BOOKING_CANCEL_ACCOUNT_WITHIN_POLICY)).toBe(false);
    expect(r.permissions.has(PERMISSIONS.ACCOUNT_SETTINGS_EDIT)).toBe(false);
    expect(r.permissions.has(PERMISSIONS.USERS_MANAGE)).toBe(false);
  });

  it('applies IMPERSONATION_DENY_INITIAL over the READ set', async () => {
    const svc = new PermissionResolverService(
      fakePool,
      makeRoleRepo([]),
      makeMembershipRepo(undefined),
    );
    const r = await svc.resolve(impersonatingAuth());

    // Every permission in IMPERSONATION_DENY_INITIAL must be absent
    for (const denied of IMPERSONATION_DENY_INITIAL) {
      expect(r.permissions.has(denied)).toBe(false);
    }
    // Specifically the three locked deny-list entries (ADR-027 D13)
    expect(r.permissions.has(PERMISSIONS.LEDGER_READ_ACCOUNT)).toBe(false);
    expect(r.permissions.has(PERMISSIONS.STATEMENTS_DOWNLOAD)).toBe(false);
    expect(r.permissions.has(PERMISSIONS.RESELLER_PROFILE_READ)).toBe(false);
  });

  it('allows SEARCH_EXECUTE during impersonation (acknowledged READ classification)', async () => {
    const svc = new PermissionResolverService(
      fakePool,
      makeRoleRepo([]),
      makeMembershipRepo(undefined),
    );
    const r = await svc.resolve(impersonatingAuth());
    expect(r.permissions.has(PERMISSIONS.SEARCH_EXECUTE)).toBe(true);
  });

  it('preserves IMPERSONATE_AGENCY_ACCOUNT so stop/active remain reachable', async () => {
    const svc = new PermissionResolverService(
      fakePool,
      makeRoleRepo([]),
      makeMembershipRepo(undefined),
    );
    const r = await svc.resolve(impersonatingAuth());
    expect(r.permissions.has(PERMISSIONS.IMPERSONATE_AGENCY_ACCOUNT)).toBe(true);
  });

  it('does not call roleRepo.findActiveRolesForUser during impersonation', async () => {
    const roleRepo = makeRoleRepo([]);
    const svc = new PermissionResolverService(
      fakePool,
      roleRepo,
      makeMembershipRepo(undefined),
    );
    await svc.resolve(impersonatingAuth());
    expect(roleRepo.findActiveRolesForUser).not.toHaveBeenCalled();
  });

  it('returns the target accountId from the AuthContext, not from membership', async () => {
    const membershipRepo = makeMembershipRepo(ACTIVE_MEMBERSHIP);
    const svc = new PermissionResolverService(
      fakePool,
      makeRoleRepo([]),
      membershipRepo,
    );
    const r = await svc.resolve(impersonatingAuth(ACCOUNT_ID));
    expect(r.accountId).toBe(ACCOUNT_ID);
    expect(membershipRepo.findActiveByUser).not.toHaveBeenCalled();
  });

  it('normal operator path is unaffected when no impersonation block is present', async () => {
    const svc = new PermissionResolverService(
      fakePool,
      makeRoleRepo(['platform_admin']),
      makeMembershipRepo(undefined),
    );
    const r = await svc.resolve(operatorAuth());
    // platform_admin holds all permissions including WRITE ones
    expect(r.permissions.has(PERMISSIONS.BOOKING_CREATE)).toBe(true);
    expect(r.permissions.has(PERMISSIONS.LEDGER_ADJUST)).toBe(true);
  });
});

// ── PERMISSION_KIND completeness ─────────────────────────────────────────────

describe('PERMISSION_KIND map', () => {
  it('classifies every PERMISSIONS entry exactly once', () => {
    for (const key of Object.keys(PERMISSIONS)) {
      const val = PERMISSIONS[key as keyof typeof PERMISSIONS] as Permission;
      expect(
        PERMISSION_KIND[val],
        `PERMISSIONS.${key} (${val}) is missing from PERMISSION_KIND`,
      ).toBeDefined();
    }
  });
});

describe('PermissionResolverService.hasPermission', () => {
  it('returns true when the resolved set contains the permission', async () => {
    const svc = new PermissionResolverService(
      fakePool,
      makeRoleRepo(['ops_support']),
      makeMembershipRepo(undefined),
    );
    expect(
      await svc.hasPermission(operatorAuth(), PERMISSIONS.BOOKING_CANCEL_MANUAL),
    ).toBe(true);
  });

  it('returns false when the permission is not held', async () => {
    const svc = new PermissionResolverService(
      fakePool,
      makeRoleRepo(['ops_support']),
      makeMembershipRepo(undefined),
    );
    expect(
      await svc.hasPermission(operatorAuth(), PERMISSIONS.LEDGER_ADJUST),
    ).toBe(false);
  });

  it('returns false for any permission when AGENCY user has no membership', async () => {
    const svc = new PermissionResolverService(
      fakePool,
      makeRoleRepo(['account_admin']),
      makeMembershipRepo(undefined),
    );
    expect(
      await svc.hasPermission(agencyAuth(), PERMISSIONS.USERS_MANAGE),
    ).toBe(false);
    expect(
      await svc.hasPermission(agencyAuth(), PERMISSIONS.SEARCH_EXECUTE),
    ).toBe(false);
  });
});
