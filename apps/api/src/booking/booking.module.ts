import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { FxModule } from '../fx/fx.module';
import { InternalAuthGuard } from '../internal-auth/internal-auth.guard';
import { BookingRepository } from './booking.repository';
import { BookingService } from './booking.service';
import { BookingController } from './booking.controller';

/**
 * Booking module (ADR-024 C5c.3).
 *
 * Imports `FxModule` to consume `BookingFxLockResolver` (Stripe
 * → OXR-only fallback decision tree) and `BookingFxLockRepository`
 * (single-row writer for `booking_fx_lock`).
 *
 * Registers `BookingController` at `/internal/bookings/...` behind
 * `InternalAuthGuard` (mirrors the FX / admin / Hotelbeds internal
 * controller pattern). The guard is provided locally so the
 * controller's class-level `@UseGuards` resolves through Nest DI.
 *
 * No public booking endpoints, no refund/cancellation routes, and no
 * payment-execution wiring in this slice — those are C5c.4 / C5d /
 * Phase 2 concerns.
 */
@Module({
  imports: [DatabaseModule, FxModule],
  controllers: [BookingController],
  providers: [InternalAuthGuard, BookingRepository, BookingService],
  exports: [BookingService],
})
export class BookingModule {}
