import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  NotImplementedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Pool } from '@bb/db';
import type { BookRequest, SupplierAdapter } from '@bb/supplier-contract';
import { PG_POOL } from '../database/database.module';
import { AuditService } from '../audit/audit.service';
import { SupplierAdapterRegistry } from '../adapters/adapter-registry';
import { BookingRepository, type BookingRecord } from './booking.repository';
import { BookingSnapshotRepository } from './booking-snapshot.repository';

/**
 * Booking Truth — Slice 3 (supplier booking, fixture mode).
 *
 * Records a deterministic supplier confirmation reference on a
 * booking **without** changing `booking_booking.status`, calling live
 * supplier APIs, moving money, or generating documents. Live booking
 * is impossible here: the Hotelbeds stub/live clients reject `book()`
 * with `NOT_IMPLEMENTED`; only the fixture client produces a ref.
 *
 * Pipeline (one call to `supplierBook`):
 *
 *   PRE-TRANSACTION (no DB tx held):
 *     1. Load the booking; 404 if absent.
 *     2. Idempotency fast-path: if `supplier_confirmation_ref` is
 *        already set, return it as `replayed: true` — no adapter
 *        call, no second audit.
 *     3. Refuse terminal bookings (CANCELLED / FAILED / REFUNDED).
 *     4. Resolve supplier ingredients: prefer the pinned
 *        `booking_sourced_offer_snapshot`; fall back to the live
 *        `offer_sourced_snapshot` via `source_offer_snapshot_id`.
 *     5. Resolve the adapter from `SupplierAdapterRegistry` and call
 *        `adapter.book(...)`. A `NOT_IMPLEMENTED` rejection (stub /
 *        live client) surfaces as 501 — nothing is written.
 *
 *   TRANSACTION (one short Postgres transaction; no network):
 *     6. BEGIN.
 *     7. `recordSupplierBooking` (status untouched). Zero rows means
 *        a concurrent terminal/duplicate transition — ROLLBACK; if a
 *        ref now exists, return it as a replay, else Conflict.
 *     8. `emitInTransaction(BOOKING_SUPPLIER_BOOKED)`. Audit failure
 *        rolls the write back — no un-audited supplier booking.
 *     9. COMMIT.
 */
@Injectable()
export class BookingSupplierService {
  private readonly logger = new Logger(BookingSupplierService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(BookingRepository)
    private readonly repository: BookingRepository,
    @Inject(BookingSnapshotRepository)
    private readonly snapshotRepository: BookingSnapshotRepository,
    @Inject(SupplierAdapterRegistry)
    private readonly registry: SupplierAdapterRegistry,
    @Inject(AuditService) private readonly auditService: AuditService,
  ) {}

  async supplierBook(
    bookingId: string,
  ): Promise<{ booking: SupplierBookingView; replayed: boolean }> {
    const existing = await this.repository.loadById(this.pool, bookingId);
    if (!existing) {
      throw new NotFoundException(`Booking not found: ${bookingId}`);
    }

    if (existing.supplierConfirmationRef !== null) {
      return { booking: toView(existing), replayed: true };
    }

    if (
      existing.status === 'CANCELLED' ||
      existing.status === 'FAILED' ||
      existing.status === 'REFUNDED'
    ) {
      throw new UnprocessableEntityException(
        `Cannot supplier-book booking ${bookingId} in terminal status ` +
          `'${existing.status}'`,
      );
    }

    if (existing.supplierRef === null) {
      throw new UnprocessableEntityException(
        `Cannot supplier-book booking ${bookingId}: supplier_ref is not ` +
          `set (booking was not created through intake)`,
      );
    }

    const ingredients = await this.resolveIngredients(existing);
    const adapter = this.resolveAdapter(existing.supplierRef);

    // Deterministic per-booking idempotency key — the fixture ref is a
    // stable hash of this, so a retried adapter call is safe.
    const idempotencyKey = `supplier-book:${existing.id}`;
    const guest = await this.repository.loadGuestContact(
      this.pool,
      existing.id,
    );
    const req: BookRequest = {
      supplierHotelId: ingredients.supplierHotelCode,
      supplierRateId: ingredients.supplierRateKey,
      supplierRawRef: existing.supplierRawRef ?? '',
      checkIn: ingredients.checkIn,
      checkOut: ingredients.checkOut,
      occupancy: { adults: ingredients.occupancyAdults, children: 0 },
      guestFirstName: guest.firstName,
      guestLastName: guest.lastName,
      guestEmail: guest.email,
      idempotencyKey,
    };

    // Outbound supplier call BEFORE any DB transaction (live would be
    // HTTP). stub/live reject NOT_IMPLEMENTED → 501, nothing written.
    let confirmation;
    try {
      confirmation = await adapter.book({ tenantId: existing.tenantId }, req);
    } catch (err) {
      if (isNotImplemented(err)) {
        throw new NotImplementedException(
          `Supplier booking is fixture-only in this slice; the ` +
            `'${existing.supplierRef}' adapter is not in fixture mode ` +
            `(live/stub booking is not implemented)`,
        );
      }
      throw err;
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const update = await this.repository.recordSupplierBooking(client, {
        bookingId: existing.id,
        supplierId: ingredients.supplierId,
        supplierConfirmationRef: confirmation.supplierBookingRef,
        supplierBookingStatus: confirmation.status,
        supplierBookingMode: 'FIXTURE',
      });
      if (!update.updated) {
        await client.query('ROLLBACK');
        const after = await this.repository.loadById(this.pool, existing.id);
        if (after && after.supplierConfirmationRef !== null) {
          return { booking: toView(after), replayed: true };
        }
        throw new ConflictException(
          `Booking ${existing.id} changed during supplier-book; retry`,
        );
      }

      await this.auditService.emitInTransaction(client, {
        category: 'APP',
        kind: 'BOOKING_SUPPLIER_BOOKED',
        tenantId: existing.tenantId,
        targetId: existing.id,
        payload: {
          bookingId: existing.id,
          tenantId: existing.tenantId,
          accountId: existing.accountId,
          bookingReference: existing.reference,
          supplierRef: existing.supplierRef,
          supplierBookingRef: confirmation.supplierBookingRef,
          supplierStatus: confirmation.status,
          mode: 'FIXTURE',
        },
      });

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }

    const after = await this.repository.loadById(this.pool, existing.id);
    this.logger.log({
      evt: 'booking_supplier_book',
      outcome: 'SUPPLIER_BOOKED',
      bookingId: existing.id,
      tenantId: existing.tenantId,
      supplierBookingRef: confirmation.supplierBookingRef,
    });
    return { booking: toView(after ?? existing), replayed: false };
  }

  private async resolveIngredients(
    booking: BookingRecord,
  ): Promise<{
    supplierId: string;
    supplierHotelCode: string;
    supplierRateKey: string;
    checkIn: string;
    checkOut: string;
    occupancyAdults: number;
  }> {
    const pinned =
      await this.snapshotRepository.loadBookingTimeOfferSnapshot(
        this.pool,
        booking.id,
      );
    if (pinned) {
      return {
        supplierId: pinned.supplier_id,
        supplierHotelCode: pinned.supplier_hotel_code,
        supplierRateKey: pinned.supplier_rate_key,
        checkIn: pinned.check_in,
        checkOut: pinned.check_out,
        occupancyAdults: pinned.occupancy_adults,
      };
    }
    if (booking.sourceOfferSnapshotId === null) {
      throw new UnprocessableEntityException(
        `Cannot supplier-book booking ${booking.id}: no pinned offer ` +
          `snapshot and source_offer_snapshot_id is null`,
      );
    }
    const live = await this.snapshotRepository.loadSourceOfferSnapshot(
      this.pool,
      booking.tenantId,
      booking.sourceOfferSnapshotId,
    );
    if (!live) {
      throw new UnprocessableEntityException(
        `Cannot supplier-book booking ${booking.id}: source offer ` +
          `snapshot ${booking.sourceOfferSnapshotId} not found ` +
          `(expired/pruned) and booking is not yet confirmed`,
      );
    }
    return {
      supplierId: live.supplier_id,
      supplierHotelCode: live.supplier_hotel_code,
      supplierRateKey: live.supplier_rate_key,
      checkIn: live.check_in,
      checkOut: live.check_out,
      occupancyAdults: live.occupancy_adults,
    };
  }

  private resolveAdapter(supplierRef: string): SupplierAdapter {
    try {
      return this.registry.get(supplierRef.toLowerCase());
    } catch {
      throw new UnprocessableEntityException(
        `No registered supplier adapter for '${supplierRef}'`,
      );
    }
  }
}

export interface SupplierBookingView {
  readonly id: string;
  readonly tenantId: string;
  readonly reference: string;
  readonly status: string;
  readonly supplierRef: string;
  readonly supplierConfirmationRef: string;
  readonly supplierBookingStatus: 'CONFIRMED' | 'ON_REQUEST';
  readonly supplierBookingMode: 'FIXTURE';
  readonly supplierBookedAt: string;
}

function toView(b: BookingRecord): SupplierBookingView {
  return {
    id: b.id,
    tenantId: b.tenantId,
    reference: b.reference,
    status: b.status,
    supplierRef: b.supplierRef ?? '',
    supplierConfirmationRef: b.supplierConfirmationRef ?? '',
    supplierBookingStatus:
      (b.supplierBookingStatus as 'CONFIRMED' | 'ON_REQUEST' | null) ??
      'CONFIRMED',
    supplierBookingMode: 'FIXTURE',
    supplierBookedAt: b.supplierBookedAt ?? '',
  };
}

function isNotImplemented(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; name?: unknown };
  return (
    e.code === 'NOT_IMPLEMENTED' ||
    (typeof e.name === 'string' && e.name.includes('NotImplemented'))
  );
}
