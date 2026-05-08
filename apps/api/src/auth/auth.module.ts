import { Module } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DatabaseModule } from '../database/database.module';
import { loadAuthConfig } from './auth.config';
import { AUTH_CONFIG } from './auth.tokens';
import { JwksCacheService } from './jwt/jwks-cache.service';
import { JwtValidatorService } from './jwt/jwt-validator.service';
import { JwtAuthGuard } from './jwt/jwt-auth.guard';
import { CoreUserRepository } from './user-sync/user.repository';
import { UserSyncService } from './user-sync/user-sync.service';
import { MeController } from './me.controller';
import { UserRoleRepository } from './permissions/user-role.repository';
import { UserAccountMembershipRepository } from './permissions/user-account-membership.repository';
import { PermissionResolverService } from './permissions/permission-resolver.service';
import { RolesGuard } from './permissions/roles.guard';

/**
 * Auth module (ADR-026 Slices E2-A + E3-A).
 *
 * Provides:
 *
 *   - `JwtAuthGuard`              — default guard for human-user routes.
 *   - `JwtValidatorService`       — Auth0 OIDC token validation.
 *   - `JwksCacheService`          — JWKS fetch + cache + rotation handling.
 *   - `UserSyncService`           — auth0_sub → core_user.id resolution
 *                                    with bootstrap-only JIT.
 *   - `CoreUserRepository`        — narrow read/write on core_user.
 *
 *   - `RolesGuard`                — default-deny permission gate (E3-A).
 *   - `PermissionResolverService` — resolves AuthContext to active
 *                                    roles + permission set, fresh
 *                                    from the DB on every request.
 *   - `UserRoleRepository`        — read/write on user_role.
 *   - `UserAccountMembershipRepository` — read/write on
 *                                    user_account_membership.
 *
 * Exports the guards, resolver, and repositories so other modules
 * can apply the guards at controller level and read role/membership
 * data without re-importing the full module.
 *
 * Endpoint retrofit is NOT in this slice — RolesGuard exists, but
 * no existing endpoint is gated by it yet. Wiring per-endpoint
 * `@UseGuards(JwtAuthGuard, RolesGuard)` + `@RequirePermission(...)`
 * is per-area work (booking, fx, search, etc.) that lands in the
 * slices retrofitting each module.
 *
 * The existing `InternalAuthGuard` is unrelated; it remains the auth
 * primitive for `/internal/*` service-to-service calls (ADR-026 D1).
 */
@Module({
  imports: [DatabaseModule],
  controllers: [MeController],
  providers: [
    {
      provide: AUTH_CONFIG,
      useFactory: loadAuthConfig,
    },
    Reflector,
    JwksCacheService,
    JwtValidatorService,
    JwtAuthGuard,
    CoreUserRepository,
    UserSyncService,

    // E3-A
    UserRoleRepository,
    UserAccountMembershipRepository,
    PermissionResolverService,
    RolesGuard,
  ],
  exports: [
    JwtAuthGuard,
    UserSyncService,
    CoreUserRepository,
    RolesGuard,
    PermissionResolverService,
    UserRoleRepository,
    UserAccountMembershipRepository,
  ],
})
export class AuthModule {}
