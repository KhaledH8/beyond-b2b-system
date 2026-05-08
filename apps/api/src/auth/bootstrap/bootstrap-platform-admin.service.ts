import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool } from '@bb/db';
import { PG_POOL } from '../../database/database.module';
import { newUlid } from '../../common/ulid';
import { CoreUserRepository } from '../user-sync/user.repository';
import { UserRoleRepository } from '../permissions/user-role.repository';

/**
 * Idempotent bootstrap of the very first `platform_admin` user
 * (Slice E2-B).
 *
 * Why this is a separate path from `UserProvisioningService`:
 *
 *   - The first deployment of the API may not yet have Management API
 *     M2M credentials configured. Bootstrap needs to work without
 *     them.
 *
 *   - The bootstrap operator typically creates themselves directly in
 *     the Auth0 dashboard first and then runs this script — so the
 *     Auth0 side already exists by the time this runs. We do not call
 *     the Management API at all.
 *
 *   - Idempotency requirement: re-running the bootstrap script must
 *     not crash and must not duplicate grants. So we read-then-write
 *     under a fixed `auth0_sub`, and the active grant uniqueness is
 *     enforced by the partial unique index on `user_role`.
 *
 * Flow:
 *
 *   1. Look up `core_user` by `auth0_sub`.
 *   2. If absent → INSERT (status=ACTIVE, user_class=OPERATOR).
 *   3. If present and active → reuse the row.
 *   4. If present but DEACTIVATED → re-activate (we are running
 *      bootstrap on this row deliberately).
 *   5. Check `user_role` for an active platform_admin grant.
 *   6. If absent → INSERT a self-grant (granted_by NULL).
 *   7. Return a summary (`created`, `roleGranted`, `userId`).
 *
 * This service does NOT enable bootstrap mode for `UserSyncService`.
 * Once the first row exists, the JIT path is no longer needed; the
 * bootstrap operator should set `AUTH0_BOOTSTRAP_MODE=false` and
 * restart the API.
 */
@Injectable()
export class BootstrapPlatformAdminService {
  private readonly logger = new Logger(BootstrapPlatformAdminService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CoreUserRepository) private readonly users: CoreUserRepository,
    @Inject(UserRoleRepository) private readonly roles: UserRoleRepository,
  ) {}

  async ensure(input: BootstrapInput): Promise<BootstrapResult> {
    if (!input.auth0Sub || !input.email || !input.tenantId) {
      throw new Error(
        'Bootstrap requires auth0Sub, email, and tenantId',
      );
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      let user = await this.users.findByAuth0Sub(client, input.auth0Sub);
      let userCreated = false;
      if (!user) {
        user = await this.users.insertProvisioned(client, {
          id: newUlid(),
          tenantId: input.tenantId,
          auth0Sub: input.auth0Sub,
          email: input.email,
          ...(input.displayName !== undefined
            ? { displayName: input.displayName }
            : {}),
          userClass: 'OPERATOR',
        });
        userCreated = true;
      } else if (user.status !== 'ACTIVE') {
        // Re-activate. Bootstrap is a deliberate ops action — running
        // it on a previously-deactivated row means the operator is
        // explicitly resurrecting it.
        await this.users.setStatus(client, input.auth0Sub, 'ACTIVE');
      }

      const existingRoles = await this.roles.findActiveRolesForUser(
        client,
        user.id,
      );
      const hasGrant = existingRoles.includes('platform_admin');
      let roleGranted = false;
      if (!hasGrant) {
        await this.roles.insert(client, {
          id: newUlid(),
          userId: user.id,
          role: 'platform_admin',
          // grantedBy NULL is explicitly allowed for the bootstrap
          // self-grant — there is no prior admin to attribute it to.
          grantedBy: null,
        });
        roleGranted = true;
      }

      await client.query('COMMIT');
      this.logger.log(
        `Bootstrap platform_admin ${userCreated ? 'created' : 'reused'} core_user.id=${user.id}; ` +
          `${roleGranted ? 'granted' : 'already had'} platform_admin`,
      );
      return {
        userId: user.id,
        created: userCreated,
        roleGranted,
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}

export interface BootstrapInput {
  readonly auth0Sub: string;
  readonly email: string;
  readonly tenantId: string;
  readonly displayName?: string;
}

export interface BootstrapResult {
  readonly userId: string;
  readonly created: boolean;
  readonly roleGranted: boolean;
}
