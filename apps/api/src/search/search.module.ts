import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AdaptersModule } from '../adapters/adapters.module';
import { FxModule } from '../fx/fx.module';
import { AuthModule } from '../auth/auth.module';
import { PgAccountRepository } from './account.repository';
import { PgHotelSupplierRepository } from './hotel-supplier.repository';
import { PgMarkupRuleRepository } from './markup-rule.repository';
import { PgPromotionRepository } from './promotion.repository';
import { PgAuthoredSearchRepository } from './authored-search.repository';
import { AuthoredSearchService } from './authored-search.service';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';

/**
 * Search module — assembles the channel-aware search seam.
 *
 * Imports `AdaptersModule` so the orchestrator can pull the
 * `SupplierAdapterRegistry` (Hotelbeds today; multi-supplier later).
 * Imports `DatabaseModule` for the per-search reads (account,
 * hotel_supplier, pricing_markup_rule, merch_promotion).
 *
 * Imports `AuthModule` to wire `JwtAuthGuard` and `RolesGuard` into
 * the `SearchController` (ADR-026 Slice E4-A retrofit pattern). The
 * guards are exported by AuthModule, so a controller-level
 * `@UseGuards(JwtAuthGuard, RolesGuard)` resolves both providers
 * from this module's injector.
 *
 * No direct dependency on object storage or payments — search reads
 * sourced offer pricing fields directly off the adapter response;
 * raw payloads are persisted by the adapter, not by search. Booking
 * / payment modules are deliberately not imported.
 */
@Module({
  imports: [DatabaseModule, AdaptersModule, FxModule, AuthModule],
  controllers: [SearchController],
  providers: [
    PgAccountRepository,
    PgHotelSupplierRepository,
    PgMarkupRuleRepository,
    PgPromotionRepository,
    PgAuthoredSearchRepository,
    AuthoredSearchService,
    SearchService,
  ],
  exports: [SearchService],
})
export class SearchModule {}
