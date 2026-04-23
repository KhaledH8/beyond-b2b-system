import { Global, Module } from '@nestjs/common';
import { HotelbedsModule } from './hotelbeds/hotelbeds.module';
import { SupplierAdapterRegistry } from './adapter-registry';

/**
 * Aggregate module for all supplier adapters. Adding a new adapter
 * is: scaffold its own module under `adapters/<name>/`, import it
 * here, register with `SupplierAdapterRegistry`.
 */
@Global()
@Module({
  imports: [HotelbedsModule],
  providers: [SupplierAdapterRegistry],
  exports: [SupplierAdapterRegistry, HotelbedsModule],
})
export class AdaptersModule {}
