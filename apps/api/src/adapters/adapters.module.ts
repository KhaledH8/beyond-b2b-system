import { Global, Module } from '@nestjs/common';
import { HotelbedsModule } from './hotelbeds/hotelbeds.module';
import { HotelbedsController } from './hotelbeds/hotelbeds.controller';
import { SupplierAdapterRegistry } from './adapter-registry';

/**
 * Aggregate module for all supplier adapters. Adding a new adapter
 * is: scaffold its own module under `adapters/<name>/`, import it
 * here, register with `SupplierAdapterRegistry`.
 *
 * Per-supplier internal/dev controllers (e.g.
 * `/internal/suppliers/hotelbeds/...`) are mounted here too — the
 * registry they depend on is provided here, and aggregating internal
 * surfaces in the same module keeps the wiring hierarchy shallow.
 * When a public search/booking surface lands later, it gets its own
 * module separate from this internal one.
 */
@Global()
@Module({
  imports: [HotelbedsModule],
  controllers: [HotelbedsController],
  providers: [SupplierAdapterRegistry],
  exports: [SupplierAdapterRegistry, HotelbedsModule],
})
export class AdaptersModule {}
