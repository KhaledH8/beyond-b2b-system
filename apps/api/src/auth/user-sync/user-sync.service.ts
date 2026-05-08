import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool } from '@bb/db';
import { PG_POOL } from '../../database/database.module';
import { newUlid } from '../../common/ulid';
import { AUTH_CONFIG, type AuthConfig } from '../auth.tokens';
import {
  CoreUserRepository,
  type CoreUserRecord,
} from './user.repository';

/**
 * Resolves an Auth0 identity (after JWT validation) to the
 * application-side `core_user.id`.
 *
 * Slice E2-A locked rule:
 *
 *   - JIT user creation is allowed ONLY when
 *     `AUTH0_BOOTSTRAP_MODE=true`.
 *   - In every other mode (i.e. in production), a missing user is a
 *     hard fail. The guard converts the `MissingUserError` into a 401
 *     and emits a structured warning log so ops can see anomalous
 *     unprovisioned tokens.
 *
 * Why so strict: admin-driven provisioning (E2-B) creates the
 * `core_user` row before the agency/operator user ever logs in. A
 * token arriving without a matching row is one of:
 *   (a) a misconfigured tenant (Auth0 user exists, our DB row never
 *       got created) — needs to fail loudly;
 *   (b) a forged or stolen token aimed at our API — must not silently
 *       create a record;
 *   (c) the bootstrap `platform_admin`'s very first login.
 *
 * Allowing JIT outside bootstrap mode would conflate (c) with (a)/(b)
 * and remove the safety signal.
 */
export class MissingUserError extends Error {
  constructor(public readonly auth0Sub: string) {
    super(
      `No core_user found for auth0_sub="${auth0Sub}" and bootstrap mode is off`,
    );
    this.name = 'MissingUserError';
  }
}

export interface SyncOnAuthInput {
  readonly auth0Sub: string;
  readonly tenantId: string;
  readonly userClass: 'OPERATOR' | 'AGENCY';
  /** Email claim on the validated JWT, if Auth0 included it. */
  readonly email?: string;
  /** Display name claim, if present. */
  readonly displayName?: string;
}

@Injectable()
export class UserSyncService {
  private readonly logger = new Logger(UserSyncService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
    @Inject(CoreUserRepository)
    private readonly users: CoreUserRepository,
  ) {}

  /**
   * Returns the existing `core_user` record for the verified Auth0
   * identity, creating one if and only if bootstrap mode is on.
   *
   * The JWT validator has already verified signature + claims, so the
   * inputs here are trusted to come from Auth0; what we don't trust
   * is whether the user has ever been provisioned in our DB.
   */
  async syncOnAuthentication(
    input: SyncOnAuthInput,
  ): Promise<CoreUserRecord> {
    const existing = await this.users.findByAuth0Sub(
      this.pool,
      input.auth0Sub,
    );
    if (existing) {
      // Sanity: token-claimed tenant_id must match the row we have.
      // A drift here means the token was minted under a tenant that
      // does not own this user row — fail closed.
      if (existing.tenantId !== input.tenantId) {
        this.logger.warn(
          `tenant_id mismatch on login: token=${input.tenantId} db=${existing.tenantId} sub=${input.auth0Sub}`,
        );
        throw new MissingUserError(input.auth0Sub);
      }
      if (existing.status !== 'ACTIVE') {
        this.logger.warn(
          `Deactivated user attempted login: sub=${input.auth0Sub}`,
        );
        throw new MissingUserError(input.auth0Sub);
      }
      // Best-effort touch; do not fail the login if the touch fails.
      await this.users.touchLogin(this.pool, existing.id).catch((err) => {
        this.logger.warn(
          `touchLogin failed for ${existing.id}: ${(err as Error).message}`,
        );
      });
      return existing;
    }

    if (!this.config.bootstrapMode) {
      this.logger.warn(
        `Login attempt for unprovisioned user (bootstrap mode off): sub=${input.auth0Sub}`,
      );
      throw new MissingUserError(input.auth0Sub);
    }

    // Bootstrap path. The JWT must carry an email claim — Auth0's
    // default behavior includes it for human users; we require it
    // explicitly so a malformed token cannot create an emailless
    // user row that violates downstream expectations.
    if (!input.email || input.email.length === 0) {
      this.logger.warn(
        `Bootstrap JIT requires email claim, none provided: sub=${input.auth0Sub}`,
      );
      throw new MissingUserError(input.auth0Sub);
    }

    const record = await this.users.insertJit(this.pool, {
      id: newUlid(),
      tenantId: input.tenantId,
      auth0Sub: input.auth0Sub,
      email: input.email,
      ...(input.displayName !== undefined
        ? { displayName: input.displayName }
        : {}),
      userClass: input.userClass,
    });
    this.logger.log(
      `Bootstrap JIT created core_user.id=${record.id} sub=${input.auth0Sub} class=${input.userClass}`,
    );
    return record;
  }
}
