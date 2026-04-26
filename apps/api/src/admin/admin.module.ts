import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { InternalAuthGuard } from '../internal-auth/internal-auth.guard';
import { MarkupRuleAdminController } from './markup-rule.controller';
import { MarkupRuleAdminRepository } from './markup-rule.repository';
import { MarkupRuleAdminService } from './markup-rule.service';
import { PromotionAdminController } from './promotion.controller';
import { PromotionAdminRepository } from './promotion.repository';
import { PromotionAdminService } from './promotion.service';

/**
 * Internal admin module for pricing + merchandising configuration.
 *
 * Mounts CRUD endpoints under `/internal/admin/...`. Imports
 * `DatabaseModule` (Pg pool) and intentionally nothing else — admin
 * does not need adapters, object storage, search, or booking. When
 * the auth module ships, an internal-only auth guard wraps this
 * module's controllers.
 *
 * Soft-delete is the only delete mode: rows transition to status
 * `INACTIVE` so older pricing traces continue to dereference rule
 * ids cleanly. The search-time evaluator filters on `ACTIVE` so
 * deactivation is effectively immediate from the consumer side.
 */
@Module({
  imports: [DatabaseModule],
  controllers: [MarkupRuleAdminController, PromotionAdminController],
  providers: [
    InternalAuthGuard,
    MarkupRuleAdminRepository,
    MarkupRuleAdminService,
    PromotionAdminRepository,
    PromotionAdminService,
  ],
  exports: [MarkupRuleAdminService, PromotionAdminService],
})
export class AdminModule {}
