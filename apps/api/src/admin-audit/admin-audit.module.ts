import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AuthModule } from '../auth/auth.module';
import { AuditEventRepository } from './audit-event.repository';
import { AuditEventService } from './audit-event.service';
import { AdminAuditController } from './admin-audit.controller';

/**
 * Wires the operator audit-log read API (`GET /admin/audit/events`).
 *
 * Imports `AuthModule` so `JwtAuthGuard`, `RolesGuard`, and
 * `PermissionResolverService` resolve from the same injector as every
 * other JWT-protected human-user route. `AuditModule` is global, so
 * `AuditService` is reachable without an explicit import here.
 *
 * `DatabaseModule` supplies the `PG_POOL` token the repository injects.
 */
@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [AdminAuditController],
  providers: [AuditEventRepository, AuditEventService],
  exports: [AuditEventService],
})
export class AdminAuditModule {}
