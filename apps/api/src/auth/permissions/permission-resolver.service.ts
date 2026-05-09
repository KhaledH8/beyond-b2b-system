import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool } from '@bb/db';
import { PG_POOL } from '../../database/database.module';
import type { AuthContext } from '../auth-context';
import {
  expandRolesToPermissions,
  IMPERSONATION_DENY_INITIAL,
  PERMISSION_KIND,
  type Permission,
  type Role,
} from './permissions';
import { UserRoleRepository } from './user-role.repository';
import { UserAccountMembershipRepository } from './user-account-membership.repository';

/**
 * Resolves whether an authenticated user holds a given permission
 * (ADR-026 Slice E3-A + ADR-027 impersonation branch).
 *
 * Locked rules:
 *
 *   - **DB-resolved per request.** No cache in this slice.
 *
 *   - **Default deny.** A user with no active grants holds no
 *     permissions.
 *
 *   - **Class coherence at read time.** `expandRolesToPermissions`
 *     silently ignores roles outside the user's class.
 *
 *   - **Account-scope coherence.** For AGENCY users we verify active
 *     membership AND token-claimed accountId match. During impersonation
 *     this check is bypassed — the target account was already validated
 *     at grant-start time and the accountId on the AuthContext is the
 *     grant's targetAccountId.
 *
 *   - **Impersonation branch (ADR-027 D7).** When `auth.impersonation`
 *     is present the resolver bypasses the operator's own roles and
 *     returns `(agency/account_admin) ∩ READ ∖ IMPERSONATION_DENY_INITIAL`
 *     plus IMPERSONATE_AGENCY_ACCOUNT so the operator can call stop/active.
 */

export interface ResolvedPermissions {
  readonly userId: string;
  readonly userClass: 'OPERATOR' | 'AGENCY';
  readonly roles: readonly Role[];
  readonly permissions: ReadonlySet<Permission>;
  /**
   * AGENCY only — the account_id the user is bound to in the DB.
   * Operator users get `null`. During impersonation this is the target
   * account id (from the grant, not from a membership row).
   */
  readonly accountId: string | null;
}

@Injectable()
export class PermissionResolverService {
  private readonly logger = new Logger(PermissionResolverService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(UserRoleRepository)
    private readonly roleRepo: UserRoleRepository,
    @Inject(UserAccountMembershipRepository)
    private readonly membershipRepo: UserAccountMembershipRepository,
  ) {}

  /**
   * Loads the full permission set for a verified `AuthContext`.
   * Every access-control decision in the request goes through this
   * call (or `hasPermission` below).
   */
  async resolve(auth: AuthContext): Promise<ResolvedPermissions> {
    // ── Impersonation branch (ADR-027 D7) ───────────────────────────
    // When the OPERATOR is acting under an impersonation grant, skip
    // their own operator roles entirely. Synthesise agency/account_admin
    // permissions filtered to READ-only, minus the initial deny-list,
    // plus IMPERSONATE_AGENCY_ACCOUNT so stop/active remain reachable.
    if (auth.impersonation) {
      const agencyAdminPerms = expandRolesToPermissions('AGENCY', [
        'account_admin',
      ]);
      const filtered = new Set<Permission>();
      for (const p of agencyAdminPerms) {
        if (
          PERMISSION_KIND[p] === 'READ' &&
          !IMPERSONATION_DENY_INITIAL.has(p)
        ) {
          filtered.add(p);
        }
      }
      // Preserve stop/active reachability while impersonating (D10).
      filtered.add('impersonate.agency_account' as Permission);

      return {
        userId: auth.userId,
        userClass: 'AGENCY',
        roles: ['account_admin'],
        permissions: filtered,
        accountId: auth.accountId, // = grant.targetAccountId (set by JwtAuthGuard)
      };
    }

    // ── Normal path ─────────────────────────────────────────────────
    const roles = await this.roleRepo.findActiveRolesForUser(
      this.pool,
      auth.userId,
    );

    let resolvedAccountId: string | null = null;
    if (auth.userClass === 'AGENCY') {
      if (auth.accountId === null) {
        this.logger.warn(
          `AGENCY user ${auth.userId} authContext.accountId is null; denying all permissions`,
        );
        return {
          userId: auth.userId,
          userClass: auth.userClass,
          roles,
          permissions: new Set(),
          accountId: null,
        };
      }

      const membership = await this.membershipRepo.findActiveByUser(
        this.pool,
        auth.userId,
      );
      if (!membership) {
        this.logger.warn(
          `AGENCY user ${auth.userId} has no active membership; denying all permissions`,
        );
        return {
          userId: auth.userId,
          userClass: auth.userClass,
          roles,
          permissions: new Set(),
          accountId: null,
        };
      }
      if (auth.accountId !== membership.accountId) {
        this.logger.warn(
          `AGENCY user ${auth.userId} token accountId=${auth.accountId} != db accountId=${membership.accountId}; denying`,
        );
        return {
          userId: auth.userId,
          userClass: auth.userClass,
          roles,
          permissions: new Set(),
          accountId: membership.accountId,
        };
      }
      resolvedAccountId = membership.accountId;
    }

    const permissions = expandRolesToPermissions(auth.userClass, roles);
    return {
      userId: auth.userId,
      userClass: auth.userClass,
      roles,
      permissions,
      accountId: resolvedAccountId,
    };
  }

  /**
   * Convenience: resolves and tests a single permission. The guard
   * uses this when only one permission is required; multi-permission
   * checks should call `resolve` once and test the returned set to
   * avoid redundant DB hits.
   */
  async hasPermission(
    auth: AuthContext,
    permission: Permission,
  ): Promise<boolean> {
    const resolved = await this.resolve(auth);
    return resolved.permissions.has(permission);
  }
}
