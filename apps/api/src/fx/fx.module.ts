import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { InternalAuthGuard } from '../internal-auth/internal-auth.guard';
import { FxRateSnapshotRepository } from './fx-rate-snapshot.repository';
import { FxApplicationRepository } from './fx-application.repository';
import { EcbFetcherService } from './ecb-fetcher.service';
import { OxrClient, loadOxrConfig } from './oxr-client';
import { OxrSyncService } from './oxr-sync.service';
import { FxRateService } from './fx-rate.service';
import { FxController } from './fx.controller';
import {
  StripeFxQuoteClient,
  loadStripeFxQuoteConfig,
} from './stripe-fx-quote.client';
import { BookingFxLockRepository } from './booking-fx-lock.repository';
import { BookingFxLockResolver } from './booking-fx-lock.resolver';

@Module({
  imports: [DatabaseModule],
  controllers: [FxController],
  providers: [
    InternalAuthGuard,
    FxRateSnapshotRepository,
    FxApplicationRepository,
    BookingFxLockRepository,
    EcbFetcherService,
    OxrSyncService,
    FxRateService,
    BookingFxLockResolver,
    {
      provide: OxrClient,
      useFactory: (): OxrClient => new OxrClient(loadOxrConfig()),
    },
    {
      provide: StripeFxQuoteClient,
      useFactory: (): StripeFxQuoteClient =>
        new StripeFxQuoteClient(loadStripeFxQuoteConfig()),
    },
  ],
  exports: [
    FxRateSnapshotRepository,
    FxApplicationRepository,
    FxRateService,
    BookingFxLockRepository,
    BookingFxLockResolver,
  ],
})
export class FxModule {}
