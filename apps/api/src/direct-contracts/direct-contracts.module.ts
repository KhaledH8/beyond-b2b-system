import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { InternalAuthGuard } from '../internal-auth/internal-auth.guard';
import { AuditLogRepository } from '../admin/audit-log.repository';
import { ContractRepository } from './contract.repository';
import { SeasonRepository } from './season.repository';
import { ChildAgeBandRepository } from './child-age-band.repository';
import { BaseRateRepository } from './base-rate.repository';
import { OccupancySupplementRepository } from './occupancy-supplement.repository';
import { MealSupplementRepository } from './meal-supplement.repository';
import { RestrictionRepository } from './restriction.repository';
import { CancellationPolicyRepository } from './cancellation-policy.repository';
import { DirectContractsService } from './direct-contracts.service';
import { ContractAdminController } from './contract.controller';
import { SeasonAdminController } from './season.controller';
import { ChildAgeBandAdminController } from './child-age-band.controller';
import { BaseRateAdminController } from './base-rate.controller';
import { OccupancySupplementAdminController } from './occupancy-supplement.controller';
import { MealSupplementAdminController } from './meal-supplement.controller';
import {
  ContractRestrictionAdminController,
  SupplierRestrictionAdminController,
} from './restriction.controller';
import {
  ContractCancellationPolicyAdminController,
  SupplierCancellationPolicyAdminController,
} from './cancellation-policy.controller';

@Module({
  imports: [DatabaseModule],
  controllers: [
    ContractAdminController,
    SeasonAdminController,
    ChildAgeBandAdminController,
    BaseRateAdminController,
    OccupancySupplementAdminController,
    MealSupplementAdminController,
    ContractRestrictionAdminController,
    SupplierRestrictionAdminController,
    ContractCancellationPolicyAdminController,
    SupplierCancellationPolicyAdminController,
  ],
  providers: [
    InternalAuthGuard,
    AuditLogRepository,
    ContractRepository,
    SeasonRepository,
    ChildAgeBandRepository,
    BaseRateRepository,
    OccupancySupplementRepository,
    MealSupplementRepository,
    RestrictionRepository,
    CancellationPolicyRepository,
    DirectContractsService,
  ],
})
export class DirectContractsModule {}
