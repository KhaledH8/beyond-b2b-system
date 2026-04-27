import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { InternalAuthGuard } from '../internal-auth/internal-auth.guard';
import { FxRateSnapshotRepository } from './fx-rate-snapshot.repository';
import { EcbFetcherService } from './ecb-fetcher.service';
import { FxController } from './fx.controller';

@Module({
  imports: [DatabaseModule],
  controllers: [FxController],
  providers: [InternalAuthGuard, FxRateSnapshotRepository, EcbFetcherService],
  exports: [FxRateSnapshotRepository],
})
export class FxModule {}
