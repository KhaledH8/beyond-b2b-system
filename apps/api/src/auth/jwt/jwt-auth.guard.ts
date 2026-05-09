import {
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Pool } from '@bb/db';
import type { Request } from 'express';
import { PG_POOL } from '../../database/database.module';
import { AUTH_CONTEXT_KEY, type AuthContext } from '../auth-context';
import {
  setImpersonationGrantId,
  setRequestActor,
} from '../../audit/request-context';
import {
  InvalidJwtError,
  JwtValidatorService,
} from './jwt-validator.service';
import {
  MissingUserError,
  UserSyncService,
} from '../user-sync/user-sync.service';
import { ImpersonationGrantRepository } from '../impersonation/impersonation-grant.repository';

/**
 * Default guard for human-user endpoints (Slice E2-A + ADR-027).
 *
 * Steps on every request:
 *
 *   1. Extract Bearer token from `Authorization` header.
 *   2. Validate signature, issuer, audience, expiry, and required
 *      claims via `JwtValidatorService`.
 *   3. Resolve the application-side `core_user` row via
 *      `UserSyncService.syncOnAuthentication`.
 *   4. For OPERATOR users: look up any active impersonation grant.
 *      If one exists, build an AGENCY-shaped `AuthContext` with the
 *      `impersonation` block set (ADR-027 D6/D7). Stamp the grant id
 *      into the request audit context so all audit events carry it.
 *   5. Stamp the authenticated actor into the request audit context
 *      (RequestIdMiddleware has already initialised it with ANONYMOUS).
 *   6. Attach `AuthContext` to the request for downstream handlers
 *      and the `@Auth()` decorator.
 *
 * Failure responses are deliberately uniform 401s with a generic
 * message. The reason is logged (warn level) but never returned to
 * the client — leaking "wrong audience" vs "expired" vs
 * "unprovisioned" gives an attacker information they shouldn't have.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(JwtAuthGuard.name);

  constructor(
    @Inject(JwtValidatorService)
    private readonly validator: JwtValidatorService,
    @Inject(UserSyncService) private readonly userSync: UserSyncService,
    @Inject(ImpersonationGrantRepository)
    private readonly grantRepo: ImpersonationGrantRepository,
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const token = extractBearer(req);
    if (!token) {
      throw new UnauthorizedException('Missing bearer token');
    }

    let claims;
    try {
      claims = await this.validator.validate(token);
    } catch (err) {
      if (err instanceof InvalidJwtError) {
        this.logger.warn(`JWT rejected: ${err.message}`);
        throw new UnauthorizedException('Invalid token');
      }
      this.logger.error(
        `JWT validation error: ${(err as Error).message}`,
      );
      throw new UnauthorizedException('Invalid token');
    }

    let user;
    try {
      user = await this.userSync.syncOnAuthentication({
        auth0Sub: claims.auth0Sub,
        tenantId: claims.tenantId,
        userClass: claims.userClass,
      });
    } catch (err) {
      if (err instanceof MissingUserError) {
        throw new UnauthorizedException('Invalid token');
      }
      throw err;
    }

    // Stamp the authenticated actor into the request audit context.
    // RequestIdMiddleware has already initialised the context with
    // ANONYMOUS; we upgrade it here now that we know the real actor.
    setRequestActor({
      actorKind: 'USER',
      actorUserId: user.id,
      tenantId: user.tenantId,
    });

    let authContext: AuthContext;

    if (user.userClass === 'OPERATOR') {
      // ADR-027 D7: check for an active impersonation grant.
      const grant = await this.grantRepo.findActiveByActor(this.pool, user.id);

      if (grant) {
        // Build AGENCY-shaped context so every downstream E4-B-style
        // reconciliation works transparently (ADR-027 D6).
        authContext = {
          auth0Sub: claims.auth0Sub,
          userId: user.id,
          tenantId: user.tenantId,
          accountId: grant.targetAccountId,
          userClass: 'AGENCY',
          impersonation: {
            grantId: grant.id,
            actorUserId: user.id,
            actorAuth0Sub: claims.auth0Sub,
            actorUserClass: 'OPERATOR',
            expiresAt: grant.expiresAt,
            scope: 'READ_ONLY',
          },
        };
        // Stamp grant id so all audit events in this request carry it.
        setImpersonationGrantId(grant.id);
      } else {
        authContext = {
          auth0Sub: claims.auth0Sub,
          userId: user.id,
          tenantId: user.tenantId,
          accountId: null,
          userClass: 'OPERATOR',
        };
      }
    } else {
      // AGENCY user: no impersonation lookup (ADR-027 D2).
      authContext = {
        auth0Sub: claims.auth0Sub,
        userId: user.id,
        tenantId: user.tenantId,
        accountId: user.userClass === 'AGENCY' ? claims.accountId : null,
        userClass: user.userClass,
      };
    }

    (req as unknown as Record<symbol, unknown>)[AUTH_CONTEXT_KEY] = authContext;
    return true;
  }
}

function extractBearer(req: Request): string | null {
  const header = req.headers['authorization'];
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1]!.trim() : null;
}
