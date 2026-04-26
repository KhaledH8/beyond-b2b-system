import { Inject, Module } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { InternalAuthGuard } from '../../internal-auth/internal-auth.guard';
import {
  HotelbedsAdapter,
  createFixtureHotelbedsClient,
  createLiveHotelbedsClient,
  createProvisionalResolver,
  createStubHotelbedsClient,
} from '@bb/adapter-hotelbeds';
import type { HotelbedsClient } from '@bb/adapter-hotelbeds';
import { DatabaseModule } from '../../database/database.module';
import { ObjectStorageModule } from '../../object-storage/object-storage.module';
import { newUlid } from '../../common/ulid';
import { PgSupplierRegistrationPort } from './supplier-registration.port';
import { PgHotelContentPersistencePort } from './hotel-content.port';
import { PgMappingPersistencePort } from './mapping-persistence.port';
import { PgSourcedOfferPersistencePort } from './sourced-offer-persistence.port';
import { MinioRawPayloadStoragePort } from './raw-payload-storage.port';
import {
  loadHotelbedsConfig,
  readFixtureFiles,
} from './hotelbeds.config';
import type { HotelbedsConfig } from './hotelbeds.config';
import {
  HOTELBEDS_ADAPTER,
  HOTELBEDS_CLIENT,
  HOTELBEDS_CONFIG,
} from './hotelbeds.module.tokens';
import { HotelbedsContentSyncService } from './content-sync.service';

export {
  HOTELBEDS_ADAPTER,
  HOTELBEDS_CLIENT,
  HOTELBEDS_CONFIG,
} from './hotelbeds.module.tokens';

/**
 * Phase 2 composition-root wiring for the Hotelbeds adapter.
 *
 * Three runtime client kinds, selected by `HOTELBEDS_CLIENT_KIND`:
 *   - `stub`    (default) — every method throws `HotelbedsNotImplementedError`.
 *                Safe for fresh checkouts that lack credentials.
 *   - `fixture` — replays JSON files in `HOTELBEDS_FIXTURE_DIR`. Used
 *                by the conformance suite and by local dev that
 *                wants the rest of the stack exercised without
 *                network IO.
 *   - `live`    — real HTTP against the Hotelbeds Booking + Content
 *                APIs, with SHA256 X-Signature auth, retry/backoff,
 *                request timeout, and optional response capture for
 *                fixture promotion.
 *
 * The selected client is registered under `HOTELBEDS_CLIENT` so other
 * services (currently `HotelbedsContentSyncService`, later potentially
 * a worker-side cron) can share the same instance the adapter uses.
 * The `pickClient(cfg)` switch lives in exactly one place.
 *
 * `createProvisionalResolver` stays on every kind: the booking guard
 * (`booking/booking-guard.ts`) is the single point that refuses to
 * book a `PROVISIONAL` rate, and that invariant must hold regardless
 * of whether the rate came from the stub, a fixture, or live HTTP.
 * Swapping in `createStaticResolver` / `createPayloadFirstResolver`
 * is gated on ops confirming Hotelbeds' commercial money-movement
 * model, not on whether HTTP is live.
 *
 * The controller (`/internal/suppliers/hotelbeds/...`) is mounted
 * here too because it is Hotelbeds-specific and only meaningful when
 * the adapter has been wired. When a second adapter lands, each gets
 * its own internal controller — there is no shared "/internal"
 * surface to pull into a separate module yet.
 */
@Module({
  imports: [DatabaseModule, ObjectStorageModule],
  providers: [
    InternalAuthGuard,
    PgSupplierRegistrationPort,
    PgHotelContentPersistencePort,
    PgMappingPersistencePort,
    PgSourcedOfferPersistencePort,
    MinioRawPayloadStoragePort,
    HotelbedsContentSyncService,
    {
      provide: HOTELBEDS_CONFIG,
      useFactory: (): HotelbedsConfig => loadHotelbedsConfig(),
    },
    {
      provide: HOTELBEDS_CLIENT,
      useFactory: (cfg: HotelbedsConfig): HotelbedsClient => pickClient(cfg),
      inject: [HOTELBEDS_CONFIG],
    },
    {
      provide: HOTELBEDS_ADAPTER,
      useFactory: (
        client: HotelbedsClient,
        registration: PgSupplierRegistrationPort,
        hotels: PgHotelContentPersistencePort,
        mappings: PgMappingPersistencePort,
        offers: PgSourcedOfferPersistencePort,
        rawStorage: MinioRawPayloadStoragePort,
      ): HotelbedsAdapter => {
        return new HotelbedsAdapter({
          client,
          registration,
          rawStorage,
          hotels,
          offers,
          mappings,
          moneyMovementResolver: createProvisionalResolver({
            fallbackTriple: {
              collectionMode: 'BB_COLLECTS',
              supplierSettlementMode: 'PREPAID_BALANCE',
              paymentCostModel: 'PLATFORM_CARD_FEE',
            },
            reason:
              'Hotelbeds commercial confirmation pending — per-rate money ' +
              'movement not yet resolved. Booking saga must refuse until ' +
              'ops swaps to createStaticResolver or createPayloadFirstResolver.',
          }),
          newSnapshotId: newUlid,
          newSearchSessionId: newUlid,
        });
      },
      inject: [
        HOTELBEDS_CLIENT,
        PgSupplierRegistrationPort,
        PgHotelContentPersistencePort,
        PgMappingPersistencePort,
        PgSourcedOfferPersistencePort,
        MinioRawPayloadStoragePort,
      ],
    },
  ],
  exports: [HOTELBEDS_ADAPTER, HOTELBEDS_CLIENT, HOTELBEDS_CONFIG, HotelbedsContentSyncService],
})
export class HotelbedsModule implements OnModuleInit {
  constructor(
    // Explicit @Inject so module bootstrap does not rely on
    // emitDecoratorMetadata. Production tsc emits it, but vitest's
    // esbuild transpiler does not — without @Inject this constructor
    // injection breaks in tests.
    @Inject(PgSupplierRegistrationPort)
    private readonly registration: PgSupplierRegistrationPort,
  ) {}

  async onModuleInit(): Promise<void> {
    // Idempotent: safe to run on every boot. Needed so any subsequent
    // `hotel_supplier` / `offer_sourced_snapshot` / mapping write has
    // a `supply_supplier` row to reference.
    await this.registration.upsertSupplier({
      supplierId: 'hotelbeds',
      displayName: 'Hotelbeds',
      ingestionMode: 'PULL',
    });
  }
}

function pickClient(cfg: HotelbedsConfig): HotelbedsClient {
  switch (cfg.kind) {
    case 'live':
      return createLiveHotelbedsClient({
        apiKey: cfg.apiKey,
        apiSecret: cfg.apiSecret,
        baseUrl: cfg.baseUrl,
        requestTimeoutMs: cfg.requestTimeoutMs,
        maxRetries: cfg.maxRetries,
        retryBaseDelayMs: cfg.retryBaseDelayMs,
        ...(cfg.captureDir !== undefined ? { captureDir: cfg.captureDir } : {}),
      });
    case 'fixture':
      return createFixtureHotelbedsClient(readFixtureFiles(cfg.fixtureDir!));
    case 'stub':
    default:
      return createStubHotelbedsClient({
        apiKey: cfg.apiKey,
        apiSecret: cfg.apiSecret,
        baseUrl: cfg.baseUrl,
        requestTimeoutMs: cfg.requestTimeoutMs,
      });
  }
}
