import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Pool } from '@bb/db';
import { PG_POOL } from '../database/database.module';
import { BookingRepository } from './booking.repository';

export interface ConfirmBookingInput {
  readonly bookingId: string;
  /**
   * 3-letter uppercase ISO 4217 currency code (e.g. 'USD'). The
   * customer's card-currency.
   *
   * Validated in C5c.1 (cheap; rejects bad calls early); **not yet
   * consumed**. C5c.2 threads this into `BookingFxLockResolver` so
   * the confirmation transaction can pin a `booking_fx_lock` row
   * alongside the status flip.
   */
  readonly chargeCurrency: string;
}

export interface ConfirmBookingResult {
  readonly bookingId: string;
  /**
   * `true` when this call hit the idempotency fast-path (booking was
   * already CONFIRMED on entry). `false` when this call performed the
   * UPDATE that flipped the row from INITIATED / PENDING_PAYMENT to
   * CONFIRMED.
   */
  readonly alreadyConfirmed: boolean;
}

/**
 * Booking confirmation shell (ADR-024 C5c.1).
 *
 * Scope of this slice is intentionally narrow:
 *   - Load the booking by id.
 *   - Validate it is in a confirmable state.
 *   - In one transaction, flip the row to `CONFIRMED`.
 *   - Return an idempotent result on a repeat confirm.
 *
 * Out of scope for this slice:
 *   - Stripe FX Quote calls (`BookingFxLockResolver`) — C5c.2.
 *   - `booking_fx_lock` writes — C5c.2.
 *   - The four ADR-021 booking-time snapshot tables — separate
 *     ADR-021 implementation slice (those tables do not yet exist).
 *   - Payment-instrument resolution that would supply
 *     `chargeCurrency` automatically — Phase 2.
 *   - A controller endpoint — added when the saga needs an external
 *     trigger; tests in C5c.1 call the service directly.
 *
 * Source-currency truth is preserved by construction: this slice
 * does not write any FX row, so the ledger / source-currency story
 * is unchanged from before C5c.
 */
@Injectable()
export class BookingService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(BookingRepository)
    private readonly repository: BookingRepository,
  ) {}

  async confirm(input: ConfirmBookingInput): Promise<ConfirmBookingResult> {
    validateChargeCurrency(input.chargeCurrency);

    const existing = await this.repository.loadById(
      this.pool,
      input.bookingId,
    );
    if (!existing) {
      throw new NotFoundException(`Booking not found: ${input.bookingId}`);
    }
    if (existing.status === 'CONFIRMED') {
      // Idempotency fast-path: already confirmed by a prior call.
      // No transaction opened; no further work.
      return { bookingId: existing.id, alreadyConfirmed: true };
    }
    if (existing.status !== 'INITIATED' && existing.status !== 'PENDING_PAYMENT') {
      // Terminal-state guard: refuse to confirm a CANCELLED, FAILED,
      // or REFUNDED booking. The caller is asking the wrong question.
      throw new BadRequestException(
        `Cannot confirm booking ${input.bookingId} in status '${existing.status}'`,
      );
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await this.repository.markConfirmed(
        client,
        input.bookingId,
      );
      if (!result.updated) {
        // The booking changed state between our load and our UPDATE
        // (concurrent confirm or cancel). Roll back the empty
        // transaction and surface a Conflict so the caller can decide
        // whether to retry or treat as final.
        await client.query('ROLLBACK');
        throw new ConflictException(
          `Booking ${input.bookingId} state changed during confirm; retry`,
        );
      }
      await client.query('COMMIT');
      return { bookingId: input.bookingId, alreadyConfirmed: false };
    } catch (err) {
      // Best-effort rollback. The earlier explicit ROLLBACK on the
      // not-updated path may have already closed the transaction; a
      // second ROLLBACK is a no-op error we tolerate so we do not
      // mask the original exception.
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}

function validateChargeCurrency(value: string): void {
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) {
    throw new BadRequestException(
      `chargeCurrency must be a 3-letter uppercase ISO 4217 code, got "${value}"`,
    );
  }
}
