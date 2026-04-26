import { Inject, Injectable } from '@nestjs/common';
import { runHotelContentSync } from '@bb/adapter-hotelbeds';
import type {
  ContentSyncRunInput,
  ContentSyncRunOutput,
  HotelbedsClient,
} from '@bb/adapter-hotelbeds';
import { HOTELBEDS_CLIENT } from './hotelbeds.module.tokens';
import { PgHotelContentPersistencePort } from './hotel-content.port';
import { MinioRawPayloadStoragePort } from './raw-payload-storage.port';

/**
 * Thin DI wrapper around `runHotelContentSync`.
 *
 * The orchestrator function is the canonical content-sync write path
 * (raw payload → `hotel_supplier` upserts). The `HotelbedsAdapter`
 * itself does not expose content-sync because the SupplierAdapter
 * contract's `fetchHotels` is a projection-only call — write-path
 * orchestration is the composition root's job.
 *
 * Injecting `HOTELBEDS_CLIENT` (rather than calling `pickClient(cfg)`
 * locally) keeps the fixture / live / stub switch in exactly one
 * place: `HotelbedsModule`. The runner inherits whatever kind that
 * module decided at boot.
 */
@Injectable()
export class HotelbedsContentSyncService {
  constructor(
    @Inject(HOTELBEDS_CLIENT) private readonly client: HotelbedsClient,
    @Inject(PgHotelContentPersistencePort)
    private readonly hotels: PgHotelContentPersistencePort,
    @Inject(MinioRawPayloadStoragePort)
    private readonly rawStorage: MinioRawPayloadStoragePort,
  ) {}

  run(input: ContentSyncRunInput): Promise<ContentSyncRunOutput> {
    return runHotelContentSync(
      {
        client: this.client,
        rawStorage: this.rawStorage,
        hotels: this.hotels,
      },
      input,
    );
  }
}
