import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { loadAuthConfig } from './auth.config';
import { AUTH_CONFIG } from './auth.tokens';
import { JwksCacheService } from './jwt/jwks-cache.service';
import { JwtValidatorService } from './jwt/jwt-validator.service';
import { JwtAuthGuard } from './jwt/jwt-auth.guard';
import { CoreUserRepository } from './user-sync/user.repository';
import { UserSyncService } from './user-sync/user-sync.service';
import { MeController } from './me.controller';

/**
 * Auth module (ADR-026 Slice E2-A).
 *
 * Provides:
 *
 *   - `JwtAuthGuard`        — the default guard for human-user routes.
 *   - `JwtValidatorService` — Auth0 OIDC token validation.
 *   - `JwksCacheService`    — JWKS fetch + cache + rotation handling.
 *   - `UserSyncService`     — auth0_sub → core_user.id resolution
 *                              with bootstrap-only JIT.
 *   - `CoreUserRepository`  — narrow read/write surface on core_user.
 *
 * Exports the guard and sync service so other modules can apply the
 * guard at controller-level (E3 onward) without re-importing the
 * full module.
 *
 * The existing `InternalAuthGuard` is unrelated; it remains the auth
 * primitive for `/internal/*` service-to-service calls. The two
 * paths never overlap (ADR-026 D1).
 */
@Module({
  imports: [DatabaseModule],
  controllers: [MeController],
  providers: [
    {
      provide: AUTH_CONFIG,
      useFactory: loadAuthConfig,
    },
    JwksCacheService,
    JwtValidatorService,
    JwtAuthGuard,
    CoreUserRepository,
    UserSyncService,
  ],
  exports: [JwtAuthGuard, UserSyncService, CoreUserRepository],
})
export class AuthModule {}
