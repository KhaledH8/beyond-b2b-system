import { Inject, Injectable } from '@nestjs/common';
import type { Queryable } from '../database/queryable';
import { newUlid } from '../common/ulid';
import {
  BookingFxLockRepository,
  type BookingFxAppliedKind,
  type BookingFxLockInput,
  type BookingFxLockRecord,
} from './booking-fx-lock.repository';
import { applyRateToMinor } from './booking-fx-rate-math';

/**
 * Applies a REFUND or CANCELLATION_FEE FX lock row by **copying forward
 * the rate and FX context from the booking's CONFIRMATION row** (ADR-024
 * C5d.2).
 *
 * The locked rule (C5d plan): refunds and cancellation fees never call
 * a fresh spot rate. They derive deterministically from the
 * confirmation-time lock so the customer receives back exactly the
 * proportion of charge currency that maps to the source-currency amount
 * being refunded/forfeited. This makes booking economics reversible at
 * a fixed rate over the booking's lifetime, which is the whole point of
 * the FX lock.
 *
 *   - If a CONFIRMATION row exists  → derive a follow-on row using the
 *                                     same `rate`, `lockKind`,
 *                                     `provider`, `provider_quote_id`,
 *                                     `rate_snapshot_id`, `expires_at`
 *                                     (whichever was set at confirm
 *                                     time), with a fresh `id` and
 *                                     `chargeMinor` = round(
 *                                       refundSourceMinor × rate).
 *   - If no CONFIRMATION row exists → no-write outcome
 *                                     `NO_CONFIRMATION_LOCK`. The
 *                                     booking either confirmed in
 *                                     source currency
 *                                     (chargeCurrency == sourceCurrency,
 *                                     NO_LOCK_NEEDED) or via the
 *                                     NO_LOCK_AVAILABLE path. In both
 *                                     cases there is no FX context to
 *                                     copy forward; refunds/cancellation
 *                                     fees are recorded against the
 *                                     source-currency amount only.
 *
 * The applier never calls Stripe, never calls OXR, and never reads
 * `FxRateService`. It only reads `BookingFxLockRepository.findConfirmation`
 * and writes via `BookingFxLockRepository.insert`. Both calls take a
 * `Queryable` so the caller's saga can run them inside its own
 * transaction (C5d.3 wires this into the future refund saga; not built
 * here).
 *
 * Rounding semantics: identical to the resolver. Both paths use
 * `applyRateToMinor` from `./booking-fx-rate-math`, which rounds
 * half-away-from-zero on a BigInt-scaled product.
 */

export type BookingFxRefundKind = Extract<
  BookingFxAppliedKind,
  'REFUND' | 'CANCELLATION_FEE'
>;

export interface ApplyRefundInput {
  readonly q: Queryable;
  readonly bookingId: string;
  readonly kind: BookingFxRefundKind;
  /** Source-currency minor amount being refunded or forfeited as fee. */
  readonly refundSourceMinor: bigint;
}

export type ApplyRefundResult =
  | {
      readonly kind: 'NO_CONFIRMATION_LOCK';
      readonly reason: 'BOOKING_HAS_NO_CONFIRMATION_LOCK';
    }
  | {
      readonly kind: 'WRITTEN';
      readonly id: string;
      readonly appliedKind: BookingFxRefundKind;
      readonly sourceMinor: bigint;
      readonly chargeMinor: bigint;
      readonly rate: string;
    };

/**
 * Pure derivation: given a CONFIRMATION record + a refund kind +
 * source-currency minor amount, build the `BookingFxLockInput` that
 * should be inserted. Throws if the confirmation record is the wrong
 * applied_kind (defensive — `findConfirmation` already filters this).
 *
 * Exported for testability: every rounding edge case can be exercised
 * without spinning up a Nest test module or mocking a repository.
 */
export function deriveRefundLockInput(args: {
  readonly confirmation: BookingFxLockRecord;
  readonly kind: BookingFxRefundKind;
  readonly refundSourceMinor: bigint;
  /** Override only used by tests so the inserted id is deterministic. */
  readonly newId?: string;
}): BookingFxLockInput {
  const { confirmation, kind, refundSourceMinor } = args;
  if (confirmation.appliedKind !== 'CONFIRMATION') {
    throw new Error(
      `deriveRefundLockInput: expected confirmation.appliedKind = 'CONFIRMATION', got '${confirmation.appliedKind}'`,
    );
  }

  const chargeMinor = applyRateToMinor(refundSourceMinor, confirmation.rate);

  // The schema's coherence CHECK requires:
  //   STRIPE_FX_QUOTE → provider_quote_id NOT NULL, expires_at NOT NULL,
  //                     rate_snapshot_id NULL
  //   SNAPSHOT_REFERENCE → rate_snapshot_id NOT NULL, provider_quote_id NULL,
  //                        expires_at NULL
  // We copy the matching fields from the confirmation row so the same
  // shape is re-asserted for REFUND / CANCELLATION_FEE.
  //
  // Note on STRIPE_FX_QUOTE expires_at: a Stripe FX quote nominally
  // expires within ~minutes; here we are *recording* which quote was
  // locked at confirmation time, not re-quoting. The expires_at copied
  // forward is the original confirmation's quote expiry — a historical
  // attribute, not a constraint that the refund row's rate is still
  // honourable on the wire. This matches the C5d locked rule "refund
  // copies forward the locked context, never re-quotes".
  return {
    id: args.newId ?? newUlid(),
    bookingId: confirmation.bookingId,
    appliedKind: kind,
    lockKind: confirmation.lockKind,
    sourceCurrency: confirmation.sourceCurrency,
    chargeCurrency: confirmation.chargeCurrency,
    rate: confirmation.rate,
    sourceMinor: refundSourceMinor,
    chargeMinor,
    provider: confirmation.provider,
    ...(confirmation.providerQuoteId !== null
      ? { providerQuoteId: confirmation.providerQuoteId }
      : {}),
    ...(confirmation.rateSnapshotId !== null
      ? { rateSnapshotId: confirmation.rateSnapshotId }
      : {}),
    ...(confirmation.expiresAt !== null
      ? { expiresAt: confirmation.expiresAt }
      : {}),
  };
}

@Injectable()
export class BookingFxLockApplier {
  constructor(
    @Inject(BookingFxLockRepository)
    private readonly repository: BookingFxLockRepository,
  ) {}

  /**
   * Applies a REFUND or CANCELLATION_FEE row for a booking by copying
   * forward the CONFIRMATION lock context.
   *
   * Both DB calls (read CONFIRMATION + insert follow-on) accept the
   * caller's `Queryable`, so the future refund saga (C5d.3) can run
   * them inside its own transaction. This applier is intentionally
   * naive about transaction boundaries: it does not BEGIN/COMMIT.
   *
   * Returns:
   *   - `{ kind: 'NO_CONFIRMATION_LOCK' }` when the booking has no
   *     CONFIRMATION row. Caller should treat this as success-with-
   *     no-FX-side-effect; refunds/cancellation fees still post to
   *     the ledger in source currency.
   *   - `{ kind: 'WRITTEN', id, sourceMinor, chargeMinor, rate }` on
   *     successful insert.
   */
  async applyRefund(input: ApplyRefundInput): Promise<ApplyRefundResult> {
    const confirmation = await this.repository.findConfirmation(
      input.q,
      input.bookingId,
    );
    if (!confirmation) {
      return {
        kind: 'NO_CONFIRMATION_LOCK',
        reason: 'BOOKING_HAS_NO_CONFIRMATION_LOCK',
      };
    }

    const row = deriveRefundLockInput({
      confirmation,
      kind: input.kind,
      refundSourceMinor: input.refundSourceMinor,
    });
    const { id } = await this.repository.insert(input.q, row);
    return {
      kind: 'WRITTEN',
      id,
      appliedKind: input.kind,
      sourceMinor: row.sourceMinor,
      chargeMinor: row.chargeMinor,
      rate: row.rate,
    };
  }
}
