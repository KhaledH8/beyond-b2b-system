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
 *   - `accountId` is non-null only when `userClass === 'AGENCY'` —
 *     or when an active impersonation grant is present (the value is
 *     then the target account id, not the operator's own account).
 *   - `userClass` distinguishes OPERATOR from AGENCY users. During an
 *     active impersonation grant it is flipped to 'AGENCY' so every
 *     retrofitted endpoint accepts the session without per-endpoint
 *     changes (ADR-027 D6 / D7).
 *   - `impersonation` is present only when an OPERATOR user has an
 *     active impersonation grant. The original operator identity is
 *     preserved in the nested block so audit trails always attribute
 *     the request to the real human (ADR-027 D6).
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

  /**
   * Present only when this request is executing under an active
   * impersonation grant (ADR-027 D6). Absent for regular operator and
   * agency sessions.
   *
   * During impersonation:
   *   - `userClass` above is 'AGENCY' (flipped from OPERATOR)
   *   - `accountId` above is the target account id
   *   - `userId` / `auth0Sub` above remain the operator's own values
   *     so audit attribution always points to the real human actor.
   */
  readonly impersonation?: {
    readonly grantId: string;
    /** The operator's core_user.id — same as AuthContext.userId. */
    readonly actorUserId: string;
    /** The operator's Auth0 sub — same as AuthContext.auth0Sub. */
    readonly actorAuth0Sub: string;
    readonly actorUserClass: 'OPERATOR';
    readonly expiresAt: string;
    readonly scope: 'READ_ONLY';
  };
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
