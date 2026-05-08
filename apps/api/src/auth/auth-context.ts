import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/**
 * The auth context attached to every authenticated human-user
 * request. Populated by `JwtAuthGuard` after the JWT has been
 * validated AND `UserSyncService` has resolved the corresponding
 * `core_user.id`.
 *
 *   - `auth0Sub` is the canonical Auth0 identity handle (`sub` claim).
 *   - `userId` is our application-side `core_user.id`.
 *   - `tenantId` is the user's tenant (single-tenant V1, but always
 *     populated so multi-tenant ports do not need to retrofit reads).
 *   - `accountId` is non-null only when `userClass === 'AGENCY'`.
 *   - `userClass` distinguishes OPERATOR from AGENCY users.
 *
 * Roles are NOT on this object. Permission checks resolve roles
 * fresh from the DB at the boundary that needs them — this is locked
 * by ADR-026 D1 ("the platform owns role and scope assignment, not
 * credential storage") and by the design note in the validator
 * (token-cached roles age stale on grant/revoke).
 */
export interface AuthContext {
  readonly auth0Sub: string;
  readonly userId: string;
  readonly tenantId: string;
  readonly accountId: string | null;
  readonly userClass: 'OPERATOR' | 'AGENCY';
}

/** Symbol used to stash the auth context on the Express request. */
export const AUTH_CONTEXT_KEY = Symbol('authContext');

/**
 * Extracts the AuthContext from the current request.
 * Defined only on requests that passed JwtAuthGuard.
 *
 * Usage:
 *   async myHandler(@Auth() auth: AuthContext) { ... }
 */
export const Auth = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthContext => {
    const req = ctx.switchToHttp().getRequest<Request>();
    return (req as unknown as Record<symbol, unknown>)[
      AUTH_CONTEXT_KEY
    ] as AuthContext;
  },
);
