import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { BookingRepository } from './booking.repository';
import { BookingService } from './booking.service';

/**
 * Booking module shell (ADR-024 C5c.1).
 *
 * Exports `BookingService` so future slices (C5c.2 onward) can inject
 * it from outside the module — though no external caller wires it
 * today. No controller is registered: this slice is service-only.
 *
 * `FxModule` is intentionally NOT imported yet. C5c.2 will add it
 * when `BookingFxLockResolver` and `BookingFxLockRepository` start
 * being called inside the confirmation transaction.
 */
@Module({
  imports: [DatabaseModule],
  providers: [BookingRepository, BookingService],
  exports: [BookingService],
})
export class BookingModule {}
