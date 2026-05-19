import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AuditModule } from '../audit/audit.module';
import { FxModule } from '../fx/fx.module';
import { InternalAuthGuard } from '../internal-auth/internal-auth.guard';
import { BookingRepository } from './booking.repository';
import { BookingService } from './booking.service';
import { BookingIntakeService } from './booking-intake.service';
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
 * Booking Intake (Slice 1) adds `BookingIntakeService` +
 * `POST /internal/bookings`. Imports `AuditModule` so
 * `BOOKING_CREATED` is written in the intake transaction even when
 * this module is booted in isolation in tests (AuditModule is @Global
 * in the full app, but isolated test graphs must import it explicitly).
 *
 * No public booking endpoints, no supplier book(), no payment, no
 * ledger, no documents, and no refund/cancellation routes in this
 * slice — those are later, deliberate slices.
 */
@Module({
  imports: [DatabaseModule, AuditModule, FxModule],
  controllers: [BookingController],
  providers: [
    InternalAuthGuard,
    BookingRepository,
    BookingService,
    BookingIntakeService,
  ],
  exports: [BookingService, BookingIntakeService],
})
export class BookingModule {}
