import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool } from '@bb/db';
import { PG_POOL } from '../../database/database.module';
import type { AuthContext } from '../auth-context';
import {
  expandRolesToPermissions,
  type Permission,
  type Role,
} from './permissions';
import { UserRoleRepository } from './user-role.repository';
import { UserAccountMembershipRepository } from './user-account-membership.repository';

/**
 * Resolves whether an authenticated user holds a given permission
 * (ADR-026 Slice E3-A).
 *
 * Locked rules:
 *
 *   - **DB-resolved per request.** No cache in this slice. ADR-026
 *     consequences mention an in-process cache as a follow-up
 *     optimization; deferring it keeps invalidation logic out of E3-A
 *     where it would compete with role-grant semantics that are
 *     still landing.
 *
 *   - **Default deny.** A user with no active grants holds no
 *     permissions. There is no implicit permission granted by being
 *     authenticated.
 *
 *   - **Class coherence at read time.** `expandRolesToPermissions`
 *     silently ignores roles outside the user's class, so a corrupted
 *     row (e.g. an OPERATOR user with `account_admin` grant) does not
 *     leak permissions. Failure mode is denial, never escalation.
 *
 *   - **Account-scope coherence.** For AGENCY users we additionally
 *     verify the user has an ACTIVE membership AND that the token-
 *     claimed `accountId` matches that membership. A drift between
 *     token claim and DB membership is treated as "no permissions"
 *     (the future write-side check at the endpoint will produce a
 *     403). Operator users skip this check (they have no membership).
 */

export interface ResolvedPermissions {
  readonly userId: string;
  readonly userClass: 'OPERATOR' | 'AGENCY';
  readonly roles: readonly Role[];
  readonly permissions: ReadonlySet<Permission>;
  /**
   * AGENCY only — the account_id the user is bound to in the DB.
   * Operator users get `null`.
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
    const roles = await this.roleRepo.findActiveRolesForUser(
      this.pool,
      auth.userId,
    );

    let resolvedAccountId: string | null = null;
    if (auth.userClass === 'AGENCY') {
      // V1 hardening: AGENCY tokens MUST carry account_id. A null
      // here is a token-shape or guard-wiring defect, not something
      // we silently paper over by trusting DB membership. The JWT
      // validator already enforces this at the OIDC layer; the
      // resolver re-asserts it as defense in depth so any future
      // alternate path that constructs an AuthContext (tests,
      // service-internal flows) still fails closed.
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
        // AGENCY user with no active membership: ADR-026 §C.5
        // invariant violated. Permissions degrade to empty set.
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
        // Token claim disagrees with DB membership. The token was
        // minted under one account; the user actually belongs to
        // another. Treat as "no permissions" — the JwtAuthGuard has
        // already passed identity verification, but authorization
        // refuses to trust the claim.
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
