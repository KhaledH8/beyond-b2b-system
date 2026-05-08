import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool } from '@bb/db';
import { PG_POOL } from '../../database/database.module';
import { newUlid } from '../../common/ulid';
import {
  CoreUserRepository,
  type CoreUserRecord,
  type UserClass,
} from '../user-sync/user.repository';
import {
  isAgencyRole,
  isOperatorRole,
  type AgencyRole,
  type OperatorRole,
  type Role,
} from '../permissions/permissions';
import { UserRoleRepository } from '../permissions/user-role.repository';
import { UserAccountMembershipRepository } from '../permissions/user-account-membership.repository';
import {
  Auth0ManagementClient,
  Auth0ManagementError,
  type Auth0UserResource,
} from './auth0-management.client';

/**
 * Admin-driven user provisioning (ADR-026 Slice E2-B).
 *
 * Creates an Auth0 user via the Management API and the matching DB
 * rows (`core_user`, `user_role` for the seed role(s), and — for AGENCY
 * users — `user_account_membership`) atomically per the slice's
 * requirement.
 *
 * Locked rules:
 *
 *   - **Auth0 first, DB second.** We POST /api/v2/users before
 *     beginning the DB transaction. If the Management API call
 *     succeeds and the DB transaction subsequently fails, we issue a
 *     compensating DELETE on the Auth0 user. Compensating-action
 *     failure is logged loudly so ops can clean up; the original
 *     error is still surfaced to the caller.
 *
 *   - **Class coherence.** OPERATOR provisioning must not carry an
 *     `accountId`; AGENCY provisioning must carry exactly one. The
 *     resolver's defense-in-depth filter would silently deny
 *     mismatched grants, but the right place to fail loud is here.
 *
 *   - **Single membership per AGENCY user.** The schema's UNIQUE
 *     (user_id) constraint is the source of truth — a second insert
 *     for the same user surfaces as a unique_violation translated
 *     into `MembershipAlreadyExistsError`. We do not pre-check; the
 *     constraint wins on race.
 *
 *   - **Roles must match class.** Operator roles on AGENCY users (and
 *     vice versa) are rejected up-front rather than written and
 *     silently denied at read time.
 *
 *   - **Bootstrap path is separate.** This service is for
 *     authenticated admin actions (E10 UI / scripted ops calls). The
 *     very first `platform_admin` is created by
 *     `BootstrapPlatformAdminService`, which must run idempotently
 *     even before a Management API M2M is configured.
 */
@Injectable()
export class UserProvisioningService {
  private readonly logger = new Logger(UserProvisioningService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(Auth0ManagementClient)
    private readonly mgmt: Auth0ManagementClient,
    @Inject(CoreUserRepository)
    private readonly users: CoreUserRepository,
    @Inject(UserRoleRepository)
    private readonly roles: UserRoleRepository,
    @Inject(UserAccountMembershipRepository)
    private readonly memberships: UserAccountMembershipRepository,
  ) {}

  /**
   * Provision a new operator user with one or more operator-class
   * role grants. Returns the created `core_user` record (the caller
   * presents this to the admin UI / response).
   */
  async provisionOperator(
    input: ProvisionOperatorInput,
  ): Promise<ProvisionResult> {
    if (input.roles.length === 0) {
      throw new InvalidProvisioningRequest(
        'At least one operator role is required',
      );
    }
    for (const r of input.roles) {
      if (!isOperatorRole(r)) {
        throw new InvalidProvisioningRequest(
          `Role "${r}" is not an operator role`,
        );
      }
    }
    return this.provision({
      tenantId: input.tenantId,
      userClass: 'OPERATOR',
      email: input.email,
      displayName: input.displayName,
      grantedBy: input.grantedBy,
      roles: input.roles,
      accountId: undefined,
    });
  }

  /**
   * Provision a new agency user, with one or more agency-class role
   * grants and exactly one account membership. The role grant and
   * membership row are written in the same transaction as the
   * `core_user` insert; either all three land or none do.
   */
  async provisionAgencyUser(
    input: ProvisionAgencyUserInput,
  ): Promise<ProvisionResult> {
    if (input.roles.length === 0) {
      throw new InvalidProvisioningRequest(
        'At least one agency role is required',
      );
    }
    for (const r of input.roles) {
      if (!isAgencyRole(r)) {
        throw new InvalidProvisioningRequest(
          `Role "${r}" is not an agency role`,
        );
      }
    }
    if (typeof input.accountId !== 'string' || input.accountId.length === 0) {
      throw new InvalidProvisioningRequest(
        'AGENCY provisioning requires accountId',
      );
    }
    return this.provision({
      tenantId: input.tenantId,
      userClass: 'AGENCY',
      email: input.email,
      displayName: input.displayName,
      grantedBy: input.grantedBy,
      roles: input.roles,
      accountId: input.accountId,
    });
  }

  private async provision(input: {
    readonly tenantId: string;
    readonly userClass: UserClass;
    readonly email: string;
    readonly displayName?: string;
    readonly grantedBy: string;
    readonly roles: readonly Role[];
    readonly accountId: string | undefined;
  }): Promise<ProvisionResult> {
    if (input.email.length === 0) {
      throw new InvalidProvisioningRequest('email must be non-empty');
    }
    let auth0User: Auth0UserResource;
    try {
      auth0User = await this.mgmt.createUser({
        email: input.email,
        tenantId: input.tenantId,
        userClass: input.userClass,
        ...(input.accountId !== undefined ? { accountId: input.accountId } : {}),
        ...(input.displayName !== undefined ? { name: input.displayName } : {}),
        emailVerified: false,
      });
    } catch (err) {
      if (err instanceof Auth0ManagementError && err.status === 409) {
        throw new EmailAlreadyTakenError(input.email);
      }
      throw err;
    }
    const auth0Sub = auth0User.user_id;
    if (typeof auth0Sub !== 'string' || auth0Sub.length === 0) {
      // Compensate: best-effort delete is not possible without a
      // user_id, so all we can do is log and surface a clear error.
      this.logger.error(
        `Auth0 createUser returned no user_id for email=${input.email}`,
      );
      throw new Error('Auth0 createUser returned no user_id');
    }

    let user: CoreUserRecord;
    try {
      user = await this.runProvisionTx({
        tenantId: input.tenantId,
        userClass: input.userClass,
        email: input.email,
        auth0Sub,
        ...(input.displayName !== undefined
          ? { displayName: input.displayName }
          : {}),
        roles: input.roles,
        accountId: input.accountId,
        grantedBy: input.grantedBy,
      });
    } catch (err) {
      // Compensating action: the Auth0 user exists but our DB row(s)
      // could not be persisted. Delete the Auth0 user so a retry of
      // the provisioning request does not collide on email.
      this.logger.warn(
        `DB provisioning failed after Auth0 createUser for sub=${auth0Sub}; attempting compensating delete: ${(err as Error).message}`,
      );
      await this.mgmt.deleteUser(auth0Sub).catch((delErr) => {
        this.logger.error(
          `Compensating Auth0 deleteUser failed for sub=${auth0Sub}; manual cleanup required: ${(delErr as Error).message}`,
        );
      });
      throw err;
    }
    return { user, auth0UserId: auth0Sub };
  }

  private async runProvisionTx(args: {
    readonly tenantId: string;
    readonly userClass: UserClass;
    readonly email: string;
    readonly auth0Sub: string;
    readonly displayName?: string;
    readonly roles: readonly Role[];
    readonly accountId: string | undefined;
    readonly grantedBy: string;
  }): Promise<CoreUserRecord> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const user = await this.users.insertProvisioned(client, {
        id: newUlid(),
        tenantId: args.tenantId,
        auth0Sub: args.auth0Sub,
        email: args.email,
        ...(args.displayName !== undefined
          ? { displayName: args.displayName }
          : {}),
        userClass: args.userClass,
      });
      if (args.userClass === 'AGENCY') {
        try {
          await this.memberships.insert(client, {
            id: newUlid(),
            userId: user.id,
            accountId: args.accountId!,
          });
        } catch (err) {
          if (isUniqueViolation(err)) {
            throw new MembershipAlreadyExistsError(user.id);
          }
          throw err;
        }
      }
      for (const role of args.roles) {
        await this.roles.insert(client, {
          id: newUlid(),
          userId: user.id,
          role,
          grantedBy: args.grantedBy,
        });
      }
      await client.query('COMMIT');
      return user;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}

export interface ProvisionOperatorInput {
  readonly tenantId: string;
  readonly email: string;
  readonly displayName?: string;
  readonly grantedBy: string;
  readonly roles: readonly OperatorRole[];
}

export interface ProvisionAgencyUserInput {
  readonly tenantId: string;
  readonly email: string;
  readonly accountId: string;
  readonly displayName?: string;
  readonly grantedBy: string;
  readonly roles: readonly AgencyRole[];
}

export interface ProvisionResult {
  readonly user: CoreUserRecord;
  readonly auth0UserId: string;
}

export class InvalidProvisioningRequest extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidProvisioningRequest';
  }
}

export class EmailAlreadyTakenError extends Error {
  constructor(email: string) {
    super(`Email "${email}" is already in use`);
    this.name = 'EmailAlreadyTakenError';
  }
}

export class MembershipAlreadyExistsError extends Error {
  constructor(userId: string) {
    super(`User ${userId} already has an active account membership`);
    this.name = 'MembershipAlreadyExistsError';
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === '23505'
  );
}
