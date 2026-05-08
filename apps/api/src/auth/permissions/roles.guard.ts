import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import {
  AUTH_CONTEXT_KEY,
  type AuthContext,
} from '../auth-context';
import {
  REQUIRE_PERMISSION_KEY,
} from './require-permission.decorator';
import type { Permission } from './permissions';
import { PermissionResolverService } from './permission-resolver.service';

/**
 * Default-deny permission gate (ADR-026 Slice E3-A).
 *
 * Application order on protected endpoints (controller-level):
 *
 *   @UseGuards(JwtAuthGuard, RolesGuard)
 *
 * The order matters: JwtAuthGuard populates `AuthContext` on the
 * request; RolesGuard reads it. NestJS evaluates guards in the order
 * given, so listing JwtAuthGuard first is required.
 *
 * Failure modes (each → 403):
 *
 *   1. AuthContext missing on the request — typically means
 *      JwtAuthGuard was not applied; this is a misconfiguration and
 *      we fail closed.
 *
 *   2. No `@RequirePermission` metadata on the handler — default
 *      deny per ADR-026 D8. An endpoint that wants to be reachable
 *      by any authenticated user should use only `@UseGuards(JwtAuthGuard)`,
 *      without RolesGuard.
 *
 *   3. The resolved permission set does not contain (every) required
 *      permission.
 *
 * Logging: rejection emits a warn with the failing permission name
 * so ops can triage "why does Acme see 403 on /foo." The 403 returned
 * to the client is uniform — no permission name in the response body.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  private readonly logger = new Logger(RolesGuard.name);

  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(PermissionResolverService)
    private readonly resolver: PermissionResolverService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const auth = (req as unknown as Record<symbol, unknown>)[
      AUTH_CONTEXT_KEY
    ] as AuthContext | undefined;
    if (!auth) {
      this.logger.warn(
        'RolesGuard hit without AuthContext on request — JwtAuthGuard missing or out of order',
      );
      throw new ForbiddenException();
    }

    const required = this.reflector.getAllAndOverride<
      readonly Permission[] | undefined
    >(REQUIRE_PERMISSION_KEY, [ctx.getHandler(), ctx.getClass()]);

    if (!required || required.length === 0) {
      // Default-deny: a route that opts into RolesGuard but does not
      // declare a required permission is a misconfiguration.
      this.logger.warn(
        `RolesGuard on a handler with no @RequirePermission metadata; denying. handler=${ctx.getHandler().name}`,
      );
      throw new ForbiddenException();
    }

    const resolved = await this.resolver.resolve(auth);
    for (const perm of required) {
      if (!resolved.permissions.has(perm)) {
        this.logger.warn(
          `Permission denied: userId=${auth.userId} userClass=${auth.userClass} missing="${perm}"`,
        );
        throw new ForbiddenException();
      }
    }
    return true;
  }
}
