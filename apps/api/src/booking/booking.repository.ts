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

/**
 * Money-movement triple (ADR-020). Written once at intake; immutable
 * for the lifetime of the booking. The repository does not interpret
 * these — the CHECK constraints in the booking-shell migration are the
 * source of truth and reject anything off-enum.
 */
export interface MoneyMovementTripleInput {
  readonly collectionMode: string;
  readonly supplierSettlementMode: string;
  readonly paymentCostModel: string;
}

export interface InsertInitiatedBookingInput {
  readonly id: string;
  readonly tenantId: string;
  readonly accountId: string;
  readonly canonicalHotelId: string;
  readonly reference: string;
  readonly checkIn: string;
  readonly checkOut: string;
  readonly guestDetails: Readonly<Record<string, unknown>>;
  readonly moneyMovement: MoneyMovementTripleInput;
  readonly sellAmountMinorUnits: bigint;
  readonly sellCurrency: string;
  readonly sourceOfferSnapshotId: string | null;
  readonly idempotencyKey: string;
  readonly supplierRef: string;
  readonly supplierRawRef: string;
}

export interface BookingIntakeRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly accountId: string;
  readonly reference: string;
  readonly status: BookingStatus;
  readonly sourceOfferSnapshotId: string | null;
  readonly supplierRef: string | null;
  readonly supplierRawRef: string | null;
  readonly sellAmountMinorUnits: bigint | null;
  readonly sellCurrency: string | null;
  readonly checkIn: string;
  readonly checkOut: string;
  readonly createdAt: string;
}

interface BookingIntakeDbRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly account_id: string;
  readonly reference: string;
  readonly status: string;
  readonly source_offer_snapshot_id: string | null;
  readonly supplier_ref: string | null;
  readonly supplier_raw_ref: string | null;
  readonly sell_amount_minor_units: string | null;
  readonly sell_currency: string | null;
  readonly check_in: string;
  readonly check_out: string;
  readonly created_at: string;
}

/**
 * Postgres returns DATE as 'YYYY-MM-DD' and TIMESTAMPTZ as a Date
 * object (node-pg type parser). Normalise both to ISO strings so the
 * API surface never leaks a JS Date or a driver-specific shape.
 */
function asIsoDateString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function intakeRowToRecord(row: BookingIntakeDbRow): BookingIntakeRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    accountId: row.account_id,
    reference: row.reference,
    status: row.status as BookingStatus,
    sourceOfferSnapshotId: row.source_offer_snapshot_id,
    supplierRef: row.supplier_ref,
    supplierRawRef: row.supplier_raw_ref,
    sellAmountMinorUnits:
      row.sell_amount_minor_units === null
        ? null
        : BigInt(row.sell_amount_minor_units),
    sellCurrency: row.sell_currency,
    checkIn: asIsoDateString(row.check_in),
    checkOut: asIsoDateString(row.check_out),
    createdAt: asIsoDateString(row.created_at),
  };
}

const INTAKE_RETURNING = `
  id, tenant_id, account_id, reference, status,
  source_offer_snapshot_id, supplier_ref, supplier_raw_ref,
  sell_amount_minor_units, sell_currency,
  to_char(check_in, 'YYYY-MM-DD')  AS check_in,
  to_char(check_out, 'YYYY-MM-DD') AS check_out,
  created_at
`;

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

  /**
   * Idempotency lookup. Returns the existing booking for a
   * (tenantId, idempotencyKey) pair, or `undefined` when none exists.
   * Backed by the partial UNIQUE index `booking_booking_idem_uq`, so a
   * replayed intake POST resolves to the original booking instead of
   * inserting a duplicate. Tenant-scoped: a key is only ever matched
   * within the caller's tenant.
   */
  async findByIdempotencyKey(
    q: Queryable,
    tenantId: string,
    idempotencyKey: string,
  ): Promise<BookingIntakeRecord | undefined> {
    const { rows } = await q.query<BookingIntakeDbRow>(
      `SELECT ${INTAKE_RETURNING}
         FROM booking_booking
        WHERE tenant_id = $1
          AND idempotency_key = $2`,
      [tenantId, idempotencyKey],
    );
    return rows.length > 0 ? intakeRowToRecord(rows[0]!) : undefined;
  }

  /**
   * Inserts a fresh INITIATED booking. Status is hard-coded to
   * 'INITIATED' (intake never creates a row in any other state);
   * `supplier_id` is intentionally left NULL — the FK to
   * `supply_supplier` is reserved for post-supplier-confirmation and a
   * real supplier booking is not made in this slice.
   *
   * Two races are surfaced to the caller, never swallowed:
   *   - reference collision  → unique violation on
   *     `booking_booking_ref_uq`; the service retries with a fresh
   *     reference.
   *   - idempotency-key race → unique violation on
   *     `booking_booking_idem_uq`; the service re-reads and returns
   *     the winner as a replay.
   *
   * Parameterised SQL only; no value is ever interpolated into the
   * statement text.
   */
  async insertInitiated(
    q: Queryable,
    input: InsertInitiatedBookingInput,
  ): Promise<BookingIntakeRecord> {
    const { rows } = await q.query<BookingIntakeDbRow>(
      `INSERT INTO booking_booking (
         id, tenant_id, account_id, canonical_hotel_id,
         collection_mode, supplier_settlement_mode, payment_cost_model,
         check_in, check_out, reference, status,
         guest_details,
         sell_amount_minor_units, sell_currency,
         source_offer_snapshot_id, idempotency_key,
         supplier_ref, supplier_raw_ref
       ) VALUES (
         $1, $2, $3, $4,
         $5, $6, $7,
         $8::date, $9::date, $10, 'INITIATED',
         $11::jsonb,
         $12, $13,
         $14, $15,
         $16, $17
       )
       RETURNING ${INTAKE_RETURNING}`,
      [
        input.id,
        input.tenantId,
        input.accountId,
        input.canonicalHotelId,
        input.moneyMovement.collectionMode,
        input.moneyMovement.supplierSettlementMode,
        input.moneyMovement.paymentCostModel,
        input.checkIn,
        input.checkOut,
        input.reference,
        JSON.stringify(input.guestDetails),
        input.sellAmountMinorUnits.toString(),
        input.sellCurrency,
        input.sourceOfferSnapshotId,
        input.idempotencyKey,
        input.supplierRef,
        input.supplierRawRef,
      ],
    );
    return intakeRowToRecord(rows[0]!);
  }
}

/**
 * Postgres unique-violation SQLSTATE. Exposed so the intake service
 * can branch on reference-collision vs idempotency-race without
 * string-matching driver error messages.
 */
export const PG_UNIQUE_VIOLATION = '23505';

export function isUniqueViolation(
  err: unknown,
  constraint?: string,
): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; constraint?: unknown };
  if (e.code !== PG_UNIQUE_VIOLATION) return false;
  if (constraint === undefined) return true;
  return e.constraint === constraint;
}
