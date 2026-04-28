import { Injectable } from '@nestjs/common';
import type { Queryable } from '../database/queryable';

/**
 * Single-row append-only writer for `booking_fx_lock` (ADR-024 C5a).
 * No reads in C5b — the refund/cancellation lookup that derives later
 * rows from the original CONFIRMATION row lands in C5d.
 *
 * Takes a `Queryable` per call (ADR-024 C5c locked design choice) so
 * the same write can be issued either through `pool` for one-shot
 * audit inserts, or through a checked-out client mid-transaction
 * (e.g. the booking-saga confirmation path in C5c.2).
 *
 * The schema's coherence CHECK enforces the per-lock-kind shape; this
 * repository's job is to translate our typed input into the row,
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
}
