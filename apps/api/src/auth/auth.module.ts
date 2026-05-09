import { Module } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DatabaseModule } from '../database/database.module';
import { AuditModule } from '../audit/audit.module';
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
import { Auth0ManagementTokenService } from './management/auth0-management-token.service';
import { Auth0ManagementClient } from './management/auth0-management.client';
import { UserProvisioningService } from './management/user-provisioning.service';
import { Auth0WebhookSignatureService } from './webhook/auth0-webhook-signature.service';
import { Auth0EventIngestionRepository } from './webhook/auth0-event-ingestion.repository';
import { Auth0EventHandlerService } from './webhook/auth0-event-handler.service';
import { Auth0WebhookController } from './webhook/auth0-webhook.controller';
import { BootstrapPlatformAdminService } from './bootstrap/bootstrap-platform-admin.service';
import { ImpersonationGrantRepository } from './impersonation/impersonation-grant.repository';
import { ImpersonationService } from './impersonation/impersonation.service';
import { ImpersonationController } from './impersonation/impersonation.controller';

/**
 * Auth module (ADR-026 Slices E2-A + E2-B + E3-A + ADR-027 V1.0).
 *
 * Provides:
 *
 *   E2-A — identity baseline:
 *     - `JwtAuthGuard`              default guard for human-user routes.
 *     - `JwtValidatorService`       Auth0 OIDC token validation.
 *     - `JwksCacheService`          JWKS fetch + cache + rotation handling.
 *     - `UserSyncService`           auth0_sub → core_user.id resolution.
 *     - `CoreUserRepository`        narrow read/write on core_user.
 *
 *   E3-A — permission infrastructure:
 *     - `RolesGuard`                default-deny permission gate.
 *     - `PermissionResolverService` AuthContext → roles + permissions
 *                                    (normal path + impersonation branch).
 *     - `UserRoleRepository`        read/write on user_role.
 *     - `UserAccountMembershipRepository` read/write on
 *                                    user_account_membership.
 *
 *   E2-B — admin provisioning + webhook ingestion + bootstrap:
 *     - `Auth0ManagementTokenService`
 *     - `Auth0ManagementClient`
 *     - `UserProvisioningService`
 *     - `Auth0WebhookSignatureService`
 *     - `Auth0EventIngestionRepository`
 *     - `Auth0EventHandlerService`
 *     - `Auth0WebhookController`
 *     - `BootstrapPlatformAdminService`
 *
 *   ADR-027 V1.0 — operator impersonation:
 *     - `ImpersonationGrantRepository`  read/write on impersonation_grant.
 *     - `ImpersonationService`          start / stop / getActive logic.
 *     - `ImpersonationController`       POST start, POST stop, GET active.
 */
@Module({
  imports: [DatabaseModule, AuditModule],
  controllers: [MeController, Auth0WebhookController, ImpersonationController],
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

    // E2-B — provisioning
    Auth0ManagementTokenService,
    Auth0ManagementClient,
    UserProvisioningService,

    // E2-B — webhook ingestion
    Auth0WebhookSignatureService,
    Auth0EventIngestionRepository,
    Auth0EventHandlerService,

    // E2-B — bootstrap
    BootstrapPlatformAdminService,

    // ADR-027 V1.0 — impersonation
    ImpersonationGrantRepository,
    ImpersonationService,
  ],
  exports: [
    JwtAuthGuard,
    UserSyncService,
    CoreUserRepository,
    RolesGuard,
    PermissionResolverService,
    UserRoleRepository,
    UserAccountMembershipRepository,
    UserProvisioningService,
    BootstrapPlatformAdminService,
    ImpersonationGrantRepository,
    ImpersonationService,
  ],
})
export class AuthModule {}
