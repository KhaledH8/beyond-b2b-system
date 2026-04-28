import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { FxModule } from '../fx/fx.module';
import { BookingRepository } from './booking.repository';
import { BookingService } from './booking.service';

/**
 * Booking module (ADR-024 C5c.2).
 *
 * Imports `FxModule` to consume `BookingFxLockResolver` (Stripe
 * → OXR-only fallback decision tree) and `BookingFxLockRepository`
 * (single-row writer for `booking_fx_lock`). Both are exported by
 * `FxModule`; this module wires them into `BookingService.confirm`.
 *
 * No controller is registered yet — confirmation is service-only,
 * exercised through tests. A controller endpoint lands in C5c.3
 * when an external trigger is needed.
 */
@Module({
  imports: [DatabaseModule, FxModule],
  providers: [BookingRepository, BookingService],
  exports: [BookingService],
})
export class BookingModule {}
