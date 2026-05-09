import { Global, Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AuditService } from './audit.service';

/**
 * Audit module (ADR-028 V1.0 steps 4–5).
 *
 * Marked @Global so AuditService is injectable anywhere without each
 * consuming module explicitly listing AuditModule in its own imports.
 * Audit is platform infrastructure — it should be universally
 * available without ceremony, just like DatabaseModule.
 *
 * RequestIdMiddleware is wired in AppModule.configure() rather than
 * here, because NestJS middleware registration requires access to the
 * MiddlewareConsumer and lives on the root module.
 */
@Global()
@Module({
  imports: [DatabaseModule],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
