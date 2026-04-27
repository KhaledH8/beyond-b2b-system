import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { InternalAuthGuard } from '../internal-auth/internal-auth.guard';
import { FxRateSnapshotRepository } from './fx-rate-snapshot.repository';
import { EcbFetcherService } from './ecb-fetcher.service';
import { OxrClient, loadOxrConfig } from './oxr-client';
import { OxrSyncService } from './oxr-sync.service';
import { FxRateService } from './fx-rate.service';
import { FxController } from './fx.controller';

@Module({
  imports: [DatabaseModule],
  controllers: [FxController],
  providers: [
    InternalAuthGuard,
    FxRateSnapshotRepository,
    EcbFetcherService,
    OxrSyncService,
    FxRateService,
    {
      provide: OxrClient,
      useFactory: (): OxrClient => new OxrClient(loadOxrConfig()),
    },
  ],
  exports: [FxRateSnapshotRepository, FxRateService],
})
export class FxModule {}
