import { Module } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import {
  HotelbedsAdapter,
  createProvisionalResolver,
  createStubHotelbedsClient,
} from '@bb/adapter-hotelbeds';
import { DatabaseModule } from '../../database/database.module';
import { ObjectStorageModule } from '../../object-storage/object-storage.module';
import { newUlid } from '../../common/ulid';
import { PgSupplierRegistrationPort } from './supplier-registration.port';
import { PgHotelContentPersistencePort } from './hotel-content.port';
import { PgMappingPersistencePort } from './mapping-persistence.port';
import { PgSourcedOfferPersistencePort } from './sourced-offer-persistence.port';
import { MinioRawPayloadStoragePort } from './raw-payload-storage.port';

export const HOTELBEDS_ADAPTER = 'HOTELBEDS_ADAPTER' as const;

/**
 * Phase 1 composition-root wiring for the Hotelbeds adapter.
 *
 * Five concrete persistence ports are constructed from Postgres /
 * MinIO providers; the adapter itself is a single singleton with a
 * stub HTTP client (real HTTP lands in Phase 2 once credentials and
 * signing are confirmed).
 *
 * `createProvisionalResolver` is chosen deliberately: Hotelbeds'
 * commercial money-movement model for this tenant has NOT been
 * confirmed in writing, so every rate returned by this adapter will
 * carry `moneyMovementProvenance = 'PROVISIONAL'` and the booking
 * guard (see `booking/booking-guard.ts`) will refuse to book it.
 * When ops confirms the contract, this module swaps the resolver to
 * `createStaticResolver({...})` or `createPayloadFirstResolver({...})`
 * — a one-line change in exactly one place.
 *
 * `ensureRegistered()` runs once at startup via `OnModuleInit` so the
 * `supply_supplier` row exists before any FK-dependent write.
 */
@Module({
  imports: [DatabaseModule, ObjectStorageModule],
  providers: [
    PgSupplierRegistrationPort,
    PgHotelContentPersistencePort,
    PgMappingPersistencePort,
    PgSourcedOfferPersistencePort,
    MinioRawPayloadStoragePort,
    {
      provide: HOTELBEDS_ADAPTER,
      useFactory: (
        registration: PgSupplierRegistrationPort,
        hotels: PgHotelContentPersistencePort,
        mappings: PgMappingPersistencePort,
        offers: PgSourcedOfferPersistencePort,
        rawStorage: MinioRawPayloadStoragePort,
      ): HotelbedsAdapter => {
        return new HotelbedsAdapter({
          client: createStubHotelbedsClient({
            apiKey: process.env['HOTELBEDS_API_KEY'] ?? '',
            apiSecret: process.env['HOTELBEDS_API_SECRET'] ?? '',
            baseUrl:
              process.env['HOTELBEDS_BASE_URL'] ??
              'https://api.test.hotelbeds.com',
            requestTimeoutMs: 15_000,
          }),
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
        PgSupplierRegistrationPort,
        PgHotelContentPersistencePort,
        PgMappingPersistencePort,
        PgSourcedOfferPersistencePort,
        MinioRawPayloadStoragePort,
      ],
    },
  ],
  exports: [HOTELBEDS_ADAPTER],
})
export class HotelbedsModule implements OnModuleInit {
  constructor(
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
