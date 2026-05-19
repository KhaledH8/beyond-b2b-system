import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AuditModule } from '../audit/audit.module';
import { AdaptersModule } from '../adapters/adapters.module';
import { FxModule } from '../fx/fx.module';
import { InternalAuthGuard } from '../internal-auth/internal-auth.guard';
import { BookingRepository } from './booking.repository';
import { BookingSnapshotRepository } from './booking-snapshot.repository';
import { BookingService } from './booking.service';
import { BookingIntakeService } from './booking-intake.service';
import { BookingSupplierService } from './booking-supplier.service';
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
 * Booking Truth Slice 3 adds `BookingSupplierService` +
 * `POST /internal/bookings/:id/supplier-book`. Imports
 * `AdaptersModule` for `SupplierAdapterRegistry` so the fixture
 * adapter is reachable when this module is booted in isolation in
 * tests. Supplier booking is fixture-only; live supplier booking,
 * payment, ledger, documents, and refund/cancellation remain later,
 * deliberate slices.
 */
@Module({
  imports: [DatabaseModule, AuditModule, AdaptersModule, FxModule],
  controllers: [BookingController],
  providers: [
    InternalAuthGuard,
    BookingRepository,
    BookingSnapshotRepository,
    BookingService,
    BookingIntakeService,
    BookingSupplierService,
  ],
  exports: [BookingService, BookingIntakeService, BookingSupplierService],
})
export class BookingModule {}
