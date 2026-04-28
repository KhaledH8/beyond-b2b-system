import { Injectable } from '@nestjs/common';
import type { Queryable } from '../database/queryable';

/**
 * Repository for `booking_fx_lock` (ADR-024 C5a).
 *
 *   - `insert` (C5b)              — append a CONFIRMATION / REFUND /
 *                                    CANCELLATION_FEE row.
 *   - `findConfirmation` (C5d.1)  — read the unique CONFIRMATION row
 *                                    for a booking, if one exists.
 *
 * Both methods take a `Queryable` per call (ADR-024 C5c locked design
 * choice) so the caller controls connection lifecycle: pass `pool` for
 * stand-alone reads / writes, or a checked-out client to participate
 * in a larger transaction (e.g. the booking-saga confirmation path).
 *
 * The schema's coherence CHECK enforces the per-lock-kind shape on
 * inserts; this repository's job is to translate typed input into rows,
 * leaving the constraint to enforce correctness. Callers that pass an
 * incoherent shape (e.g. STRIPE_FX_QUOTE without `expiresAt`) get a
 * Postgres CHECK violation back, not a silent insert.
 */

export type BookingFxAppliedKind =
  | 'CONFIRMATION'
  | 'REFUND'
  | 'CANCELLATION_FEE';

export type BookingFxLockKind = 'STRIPE_FX_QUOTE' | 'SNAPSHOT_REFERENCE';
export type BookingFxLockProvider = 'STRIPE' | 'OXR';

export interface BookingFxLockInput {
  readonly id: string;
  readonly bookingId: string;
  readonly appliedKind: BookingFxAppliedKind;
  readonly lockKind: BookingFxLockKind;
  readonly sourceCurrency: string;
  readonly chargeCurrency: string;
  /** 8-decimal string. Semantics: 1 source = N charge. */
  readonly rate: string;
  readonly sourceMinor: bigint;
  readonly chargeMinor: bigint;
  readonly provider: BookingFxLockProvider;
  /** Required when lockKind === 'STRIPE_FX_QUOTE'. */
  readonly providerQuoteId?: string;
  /** Required when lockKind === 'SNAPSHOT_REFERENCE'. */
  readonly rateSnapshotId?: string;
  /** Required (ISO 8601 UTC) when lockKind === 'STRIPE_FX_QUOTE'. */
  readonly expiresAt?: string;
}

/**
 * Read shape for an existing `booking_fx_lock` row (ADR-024 C5d.1).
 *
 * Mirrors `BookingFxLockInput` but reflects the row as the DB stores
 * it: `providerQuoteId`, `rateSnapshotId`, and `expiresAt` are
 * `string | null` (the columns are nullable per the C5a schema, with
 * the coherence CHECK deciding which one is populated for a given
 * `lockKind`). `appliedAt` is the DB-stamped timestamp (always
 * present).
 *
 * Callers that need to derive a follow-on REFUND / CANCELLATION_FEE
 * input (C5d.2) translate `null` → `undefined` when reshaping into a
 * `BookingFxLockInput`.
 */
export interface BookingFxLockRecord {
  readonly id: string;
  readonly bookingId: string;
  readonly appliedKind: BookingFxAppliedKind;
  readonly lockKind: BookingFxLockKind;
  readonly sourceCurrency: string;
  readonly chargeCurrency: string;
  readonly rate: string;
  readonly sourceMinor: bigint;
  readonly chargeMinor: bigint;
  readonly provider: BookingFxLockProvider;
  readonly providerQuoteId: string | null;
  readonly rateSnapshotId: string | null;
  readonly expiresAt: string | null;
  /** ISO 8601 UTC, DB-stamped at insert time. */
  readonly appliedAt: string;
}

interface BookingFxLockDbRow {
  readonly id: string;
  readonly booking_id: string;
  readonly applied_kind: string;
  readonly lock_kind: string;
  readonly source_currency: string;
  readonly charge_currency: string;
  readonly rate: string;
  readonly source_minor: string;
  readonly charge_minor: string;
  readonly provider: string;
  readonly provider_quote_id: string | null;
  readonly rate_snapshot_id: string | null;
  readonly expires_at: Date | string | null;
  readonly applied_at: Date | string;
}

function toIsoString(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function rowToRecord(row: BookingFxLockDbRow): BookingFxLockRecord {
  return {
    id: row.id,
    bookingId: row.booking_id,
    appliedKind: row.applied_kind as BookingFxAppliedKind,
    lockKind: row.lock_kind as BookingFxLockKind,
    sourceCurrency: row.source_currency,
    chargeCurrency: row.charge_currency,
    rate: row.rate,
    sourceMinor: BigInt(row.source_minor),
    chargeMinor: BigInt(row.charge_minor),
    provider: row.provider as BookingFxLockProvider,
    providerQuoteId: row.provider_quote_id,
    rateSnapshotId: row.rate_snapshot_id,
    expiresAt: row.expires_at === null ? null : toIsoString(row.expires_at),
    appliedAt: toIsoString(row.applied_at),
  };
}

@Injectable()
export class BookingFxLockRepository {
  /**
   * Inserts one row using the supplied `Queryable`. Pass `pool` for a
   * stand-alone insert; pass a checked-out client to participate in
   * an open transaction (the C5c.2 confirmation path).
   *
   * Idempotency for `applied_kind = 'CONFIRMATION'` is enforced by
   * the partial unique index `booking_fx_lock_confirmation_uq`; a
   * second CONFIRMATION row for the same booking_id surfaces as a
   * Postgres `unique_violation` (SQLSTATE 23505).
   */
  async insert(
    q: Queryable,
    input: BookingFxLockInput,
  ): Promise<{ id: string }> {
    const sql = `
      INSERT INTO booking_fx_lock (
        id, booking_id, applied_kind, lock_kind,
        source_currency, charge_currency,
        rate, source_minor, charge_minor,
        provider, provider_quote_id, rate_snapshot_id, expires_at
      )
      VALUES (
        $1, $2, $3, $4,
        $5, $6,
        $7::numeric, $8::bigint, $9::bigint,
        $10, $11, $12, $13::timestamptz
      )
      RETURNING id
    `;
    const values: unknown[] = [
      input.id,
      input.bookingId,
      input.appliedKind,
      input.lockKind,
      input.sourceCurrency,
      input.chargeCurrency,
      input.rate,
      input.sourceMinor.toString(),
      input.chargeMinor.toString(),
      input.provider,
      input.providerQuoteId ?? null,
      input.rateSnapshotId ?? null,
      input.expiresAt ?? null,
    ];
    const { rows } = await q.query<{ id: string }>(sql, values);
    return { id: rows[0]!.id };
  }

  /**
   * Returns the unique CONFIRMATION row for `bookingId`, if one exists.
   *
   * The partial unique index `booking_fx_lock_confirmation_uq` (C5a)
   * guarantees at most one CONFIRMATION row per booking, so this read
   * never needs to disambiguate. If the booking confirmed in source
   * currency (chargeCurrency == sourceCurrency) or via the
   * `NO_LOCK_AVAILABLE` path, no CONFIRMATION row exists and the
   * method returns `undefined` — callers (the future C5d.2 applier)
   * treat that as the "no FX context to derive from" signal and skip
   * writing a follow-on REFUND / CANCELLATION_FEE row.
   *
   * REFUND and CANCELLATION_FEE rows for the same booking are
   * intentionally ignored by this query; the predicate scopes to
   * `applied_kind = 'CONFIRMATION'` only.
   */
  async findConfirmation(
    q: Queryable,
    bookingId: string,
  ): Promise<BookingFxLockRecord | undefined> {
    const sql = `
      SELECT id, booking_id, applied_kind, lock_kind,
             source_currency, charge_currency,
             rate, source_minor, charge_minor,
             provider, provider_quote_id, rate_snapshot_id,
             expires_at, applied_at
        FROM booking_fx_lock
       WHERE booking_id = $1
         AND applied_kind = 'CONFIRMATION'
    `;
    const { rows } = await q.query<BookingFxLockDbRow>(sql, [bookingId]);
    return rows.length > 0 ? rowToRecord(rows[0]!) : undefined;
  }
}
