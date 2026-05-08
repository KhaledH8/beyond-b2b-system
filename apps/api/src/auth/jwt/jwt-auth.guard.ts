import {
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import { AUTH_CONTEXT_KEY, type AuthContext } from '../auth-context';
import {
  InvalidJwtError,
  JwtValidatorService,
} from './jwt-validator.service';
import {
  MissingUserError,
  UserSyncService,
} from '../user-sync/user-sync.service';

/**
 * Default guard for human-user endpoints (Slice E2-A).
 *
 * Steps on every request:
 *
 *   1. Extract Bearer token from `Authorization` header.
 *   2. Validate signature, issuer, audience, expiry, and required
 *      claims via `JwtValidatorService`.
 *   3. Resolve the application-side `core_user` row via
 *      `UserSyncService.syncOnAuthentication`. Outside bootstrap
 *      mode, an unprovisioned token is a 401 — never a JIT create.
 *   4. Attach `AuthContext` to the request for downstream handlers
 *      and the `@Auth()` decorator.
 *
 * Failure responses are deliberately uniform 401s with a generic
 * message. The reason is logged (warn level) but never returned to
 * the client — leaking "wrong audience" vs "expired" vs
 * "unprovisioned" gives an attacker information they shouldn't have.
 *
 * The existing `InternalAuthGuard` is unchanged. Internal `/internal/*`
 * endpoints continue to use it; this guard is for human-user routes.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(JwtAuthGuard.name);

  constructor(
    @Inject(JwtValidatorService)
    private readonly validator: JwtValidatorService,
    @Inject(UserSyncService) private readonly userSync: UserSyncService,
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
      // JWKS fetch failure or similar — surface a 401, not a 5xx,
      // because from the client's perspective auth is unavailable.
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
        // Already logged at warn inside the sync service.
        throw new UnauthorizedException('Invalid token');
      }
      throw err;
    }

    // Reconcile token-claimed account_id against DB tenant. The
    // user_account_membership lookup that confirms the account_id
    // belongs to this user lands in E3; in this slice we attach the
    // claim verbatim if the user is AGENCY-class.
    const authContext: AuthContext = {
      auth0Sub: claims.auth0Sub,
      userId: user.id,
      tenantId: user.tenantId,
      accountId: user.userClass === 'AGENCY' ? claims.accountId : null,
      userClass: user.userClass,
    };
    (req as unknown as Record<symbol, unknown>)[AUTH_CONTEXT_KEY] =
      authContext;
    return true;
  }
}

function extractBearer(req: Request): string | null {
  const header = req.headers['authorization'];
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1]!.trim() : null;
}
