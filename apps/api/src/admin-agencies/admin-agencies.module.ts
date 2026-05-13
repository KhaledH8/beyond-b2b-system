import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AuthModule } from '../auth/auth.module';
import { AdminAgenciesController } from './admin-agencies.controller';
import { AgencySelectorRepository } from './agency-selector.repository';
import { AgencySelectorService } from './agency-selector.service';

/**
 * Wires the operator agency selector endpoint (`GET /admin/agencies`).
 *
 * Imports `AuthModule` so `JwtAuthGuard` + `RolesGuard` resolve from
 * the same injector that the rest of the human-user routes use
 * (mirrors `SearchModule`). Imports `DatabaseModule` for the
 * repository's pool injection.
 */
@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [AdminAgenciesController],
  providers: [AgencySelectorRepository, AgencySelectorService],
  exports: [AgencySelectorService],
})
export class AdminAgenciesModule {}
