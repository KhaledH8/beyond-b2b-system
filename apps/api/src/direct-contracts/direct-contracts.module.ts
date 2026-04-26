import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { InternalAuthGuard } from '../internal-auth/internal-auth.guard';
import { AuditLogRepository } from '../admin/audit-log.repository';
import { ContractRepository } from './contract.repository';
import { SeasonRepository } from './season.repository';
import { ChildAgeBandRepository } from './child-age-band.repository';
import { DirectContractsService } from './direct-contracts.service';
import { ContractAdminController } from './contract.controller';
import { SeasonAdminController } from './season.controller';
import { ChildAgeBandAdminController } from './child-age-band.controller';

@Module({
  imports: [DatabaseModule],
  controllers: [
    ContractAdminController,
    SeasonAdminController,
    ChildAgeBandAdminController,
  ],
  providers: [
    InternalAuthGuard,
    AuditLogRepository,
    ContractRepository,
    SeasonRepository,
    ChildAgeBandRepository,
    DirectContractsService,
  ],
})
export class DirectContractsModule {}
