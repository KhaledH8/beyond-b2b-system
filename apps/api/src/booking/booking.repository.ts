import { Injectable } from '@nestjs/common';
import type { Queryable } from '../database/queryable';

/**
 * Closed set of booking lifecycle states (mirrors the
 * `booking_booking_status_chk` CHECK constraint in the booking-shell
 * migration). Kept in sync by hand — adding a status is a deliberate
 * edit on both sides.
 */
export type BookingStatus =
  | 'INITIATED'
  | 'PENDING_PAYMENT'
  | 'CONFIRMED'
  | 'CANCELLED'
  | 'FAILED'
  | 'REFUNDED';

export interface BookingRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly status: BookingStatus;
  /**
   * Pricing snapshot fields. Both columns are nullable in the schema
   * (booking-shell migration) — a booking can sit in `INITIATED`
   * before pricing has been pinned. Later C5c slices that need the
   * source-currency amount/currency must handle the `null` case
   * explicitly; C5c.1 does not consume these fields.
   */
  readonly sellAmountMinorUnits: bigint | null;
  readonly sellCurrency: string | null;
}

interface BookingDbRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly status: string;
  readonly sell_amount_minor_units: string | null;
  readonly sell_currency: string | null;
}

function rowToRecord(row: BookingDbRow): BookingRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    status: row.status as BookingStatus,
    sellAmountMinorUnits:
      row.sell_amount_minor_units === null
        ? null
        : BigInt(row.sell_amount_minor_units),
    sellCurrency: row.sell_currency,
  };
}

@Injectable()
export class BookingRepository {
  /**
   * One-shot read by id. Caller passes either the pool (plain read)
   * or a checked-out client (inside a transaction). Returns
   * `undefined` when the row does not exist — callers translate that
   * into a domain-level NotFound.
   */
  async loadById(
    q: Queryable,
    bookingId: string,
  ): Promise<BookingRecord | undefined> {
    const { rows } = await q.query<BookingDbRow>(
      `SELECT id, tenant_id, status,
              sell_amount_minor_units, sell_currency
         FROM booking_booking
        WHERE id = $1`,
      [bookingId],
    );
    return rows.length > 0 ? rowToRecord(rows[0]!) : undefined;
  }

  /**
   * Conditional UPDATE: only flips status to CONFIRMED when the
   * current status is INITIATED or PENDING_PAYMENT. Returns
   * `{ updated: true }` when one row matched, `{ updated: false }`
   * otherwise (booking already confirmed, in a terminal state, or
   * absent — caller distinguishes via `loadById`).
   *
   * The `WHERE` filter is the saga's primary idempotency lever: a
   * second confirm against an already-CONFIRMED booking matches zero
   * rows and the service treats that as `alreadyConfirmed: true`.
   */
  async markConfirmed(
    q: Queryable,
    bookingId: string,
  ): Promise<{ updated: boolean }> {
    const { rows } = await q.query<{ id: string }>(
      `UPDATE booking_booking
          SET status = 'CONFIRMED',
              updated_at = now()
        WHERE id = $1
          AND status IN ('INITIATED', 'PENDING_PAYMENT')
        RETURNING id`,
      [bookingId],
    );
    return { updated: rows.length === 1 };
  }
}
