import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Pool } from '@bb/db';
import { PG_POOL } from '../database/database.module';
import {
  BookingFxLockResolver,
  type BookingFxLockDecision,
} from '../fx/booking-fx-lock.resolver';
import {
  BookingFxLockRepository,
  type BookingFxLockInput,
} from '../fx/booking-fx-lock.repository';
import { newUlid } from '../common/ulid';
import { BookingRepository } from './booking.repository';

export interface ConfirmBookingInput {
  readonly bookingId: string;
  /**
   * 3-letter uppercase ISO 4217 currency code (e.g. 'USD'). The
   * customer's card-currency. Validated and used to drive the
   * booking-time FX lock decision (ADR-024 C5c.2).
   */
  readonly chargeCurrency: string;
}

/**
 * Outcome of the FX-lock decision for one confirm call.
 *
 *   NO_LOCK_NEEDED      — source currency equals charge currency;
 *                         resolver was not consulted; no row written.
 *   NO_LOCK_AVAILABLE   — Stripe failed AND OXR had no fresh DIRECT
 *                         or INVERSE snapshot for the pair; no row
 *                         written; booking confirmed in source
 *                         currency.
 *   STRIPE_FX_QUOTE     — Stripe locked the rate; one CONFIRMATION
 *                         row inserted with provider='STRIPE'.
 *   SNAPSHOT_REFERENCE  — OXR snapshot used as reference rate; one
 *                         CONFIRMATION row inserted with
 *                         provider='OXR'. ECB is never used here.
 */
export type ConfirmFxOutcome =
  | { readonly kind: 'NO_LOCK_NEEDED' }
  | { readonly kind: 'NO_LOCK_AVAILABLE' }
  | { readonly kind: 'STRIPE_FX_QUOTE'; readonly provider: 'STRIPE' }
  | { readonly kind: 'SNAPSHOT_REFERENCE'; readonly provider: 'OXR' };

export interface ConfirmBookingResult {
  readonly bookingId: string;
  /**
   * `true` when this call hit the idempotency fast-path (booking was
   * already CONFIRMED on entry). `false` when this call performed
   * the UPDATE that flipped the row from INITIATED / PENDING_PAYMENT
   * to CONFIRMED.
   */
  readonly alreadyConfirmed: boolean;
  /**
   * FX-lock outcome for this call. Absent on the `alreadyConfirmed`
   * fast-path — the lock decision was made by the prior call, not
   * this one. Callers needing the original lock can read
   * `booking_fx_lock` directly (slated for C5d).
   */
  readonly fxOutcome?: ConfirmFxOutcome;
}

/**
 * Booking confirmation orchestrator (ADR-024 C5c.2).
 *
 * Pipeline (one call to `confirm`):
 *
 *   PRE-TRANSACTION (network OK, no DB transaction held):
 *     1. Validate `chargeCurrency` shape.
 *     2. Load booking by id; refuse on NotFound.
 *     3. Idempotency fast-path on status = CONFIRMED.
 *     4. Refuse terminal-state bookings (CANCELLED / FAILED / REFUNDED).
 *     5. Refuse unpriced bookings (sell_amount_minor_units OR
 *        sell_currency is null) — locked policy: an unpriced booking
 *        never reaches the FX-lock path.
 *     6. If source currency == charge currency, decision is
 *        NO_LOCK_NEEDED; resolver is NOT consulted.
 *     7. Otherwise call `BookingFxLockResolver.resolve(...)`.
 *        Resolver does Stripe → OXR-only fallback. ECB is never
 *        consulted by construction (locked correction in the C5
 *        plan; enforced inside the resolver).
 *
 *   TRANSACTION (one Postgres transaction; pure SQL, no network):
 *     8. BEGIN.
 *     9. UPDATE booking_booking SET status='CONFIRMED' (conditional
 *        on current status). Zero rows means the state changed
 *        between load and UPDATE — ROLLBACK + Conflict.
 *    10. If the resolver returned STRIPE_FX_QUOTE or
 *        SNAPSHOT_REFERENCE, INSERT one CONFIRMATION row into
 *        booking_fx_lock on the same client. CHECK / FK / unique
 *        violations roll back the booking status flip too — the
 *        whole transaction is all-or-nothing.
 *    11. COMMIT.
 *
 * Source-currency truth is preserved: no LedgerEntry is read or
 * written here. The booking's `sell_amount_minor_units` /
 * `sell_currency` are the source-currency commitment; the FX lock
 * is a parallel record of what the customer's card sees.
 */
@Injectable()
export class BookingService {
  /**
   * NestJS built-in `Logger`. The codebase has no project-wide logger
   * pattern beyond a single `console.log` in `main.ts` (ADR-024 C5c.4
   * narrow-honest choice: use Nest's Logger so future global logger
   * swaps via `app.useLogger(...)` pick this up automatically).
   *
   * Levels in this service:
   *   - `.log`    success outcomes (CONFIRMED, ALREADY_CONFIRMED)
   *   - `.warn`   user-side errors (NOT_FOUND, INVALID, CONFLICT)
   *   - `.error`  system errors (DB / resolver / unexpected throws)
   *
   * Event shape — never includes PII, secrets, raw card details, or
   * Stripe quote ids beyond what is already DB-resident:
   *   { evt: 'booking_confirm', outcome, bookingId, chargeCurrency,
   *     sourceCurrency?, alreadyConfirmed?, fxOutcomeKind?, provider?,
   *     errorReason? }
   */
  private readonly logger = new Logger(BookingService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(BookingRepository)
    private readonly repository: BookingRepository,
    @Inject(BookingFxLockResolver)
    private readonly resolver: BookingFxLockResolver,
    @Inject(BookingFxLockRepository)
    private readonly lockRepository: BookingFxLockRepository,
  ) {}

  async confirm(input: ConfirmBookingInput): Promise<ConfirmBookingResult> {
    // Trace fields collected as we progress through the pipeline. The
    // outer `finally` reads these to build the structured event so we
    // emit exactly one log line per attempt regardless of outcome.
    let sourceCurrency: string | undefined;
    let outcome: ConfirmBookingResult | undefined;
    let error: unknown;

    try {
      validateChargeCurrency(input.chargeCurrency);

      const existing = await this.repository.loadById(
        this.pool,
        input.bookingId,
      );
      if (!existing) {
        throw new NotFoundException(`Booking not found: ${input.bookingId}`);
      }
      if (existing.status === 'CONFIRMED') {
        // Idempotency fast-path: prior call already drove this booking
        // to CONFIRMED (and made the FX-lock decision then). No tx,
        // no resolver, no FX write. Caller distinguishes via
        // `alreadyConfirmed`.
        outcome = { bookingId: existing.id, alreadyConfirmed: true };
        return outcome;
      }
      if (
        existing.status !== 'INITIATED' &&
        existing.status !== 'PENDING_PAYMENT'
      ) {
        throw new BadRequestException(
          `Cannot confirm booking ${input.bookingId} in status '${existing.status}'`,
        );
      }
      if (
        existing.sellAmountMinorUnits === null ||
        existing.sellCurrency === null
      ) {
        // Locked policy: an unpriced booking does not silently degrade
        // to "no lock needed". Pricing must be pinned before
        // confirmation can resolve an FX commitment.
        throw new BadRequestException(
          `Cannot confirm booking ${input.bookingId}: pricing not pinned ` +
            `(sell_amount_minor_units or sell_currency is null)`,
        );
      }

      sourceCurrency = existing.sellCurrency;
      const sourceMinor = existing.sellAmountMinorUnits;

      // Pre-transaction: resolver may make outbound HTTP calls. Run
      // before BEGIN so a slow Stripe response does not extend the
      // transaction window.
      let decision: BookingFxLockDecision;
      if (sourceCurrency === input.chargeCurrency) {
        decision = { kind: 'NO_LOCK_NEEDED', reason: 'SAME_CURRENCY' };
      } else {
        decision = await this.resolver.resolve({
          sourceCurrency,
          chargeCurrency: input.chargeCurrency,
          sourceMinor,
        });
      }

      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const update = await this.repository.markConfirmed(
          client,
          input.bookingId,
        );
        if (!update.updated) {
          await client.query('ROLLBACK');
          throw new ConflictException(
            `Booking ${input.bookingId} state changed during confirm; retry`,
          );
        }
        if (
          decision.kind === 'STRIPE_FX_QUOTE' ||
          decision.kind === 'SNAPSHOT_REFERENCE'
        ) {
          const lockInput = decisionToLockInput(decision, input.bookingId);
          await this.lockRepository.insert(client, lockInput);
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }

      outcome = {
        bookingId: input.bookingId,
        alreadyConfirmed: false,
        fxOutcome: decisionToOutcome(decision),
      };
      return outcome;
    } catch (err) {
      error = err;
      throw err;
    } finally {
      this.emitConfirmEvent({ input, outcome, error, sourceCurrency });
    }
  }

  private emitConfirmEvent(args: {
    readonly input: ConfirmBookingInput;
    readonly outcome: ConfirmBookingResult | undefined;
    readonly error: unknown;
    readonly sourceCurrency: string | undefined;
  }): void {
    const event = buildConfirmEvent(args);
    if (event.outcome === 'ERROR') {
      this.logger.error(event);
    } else if (
      event.outcome === 'NOT_FOUND' ||
      event.outcome === 'INVALID' ||
      event.outcome === 'CONFLICT'
    ) {
      this.logger.warn(event);
    } else {
      this.logger.log(event);
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

function decisionToOutcome(
  decision: BookingFxLockDecision,
): ConfirmFxOutcome {
  switch (decision.kind) {
    case 'NO_LOCK_NEEDED':
      return { kind: 'NO_LOCK_NEEDED' };
    case 'NO_LOCK_AVAILABLE':
      return { kind: 'NO_LOCK_AVAILABLE' };
    case 'STRIPE_FX_QUOTE':
      return { kind: 'STRIPE_FX_QUOTE', provider: 'STRIPE' };
    case 'SNAPSHOT_REFERENCE':
      return { kind: 'SNAPSHOT_REFERENCE', provider: 'OXR' };
  }
}

type ConfirmEventOutcome =
  | 'CONFIRMED'
  | 'ALREADY_CONFIRMED'
  | 'NOT_FOUND'
  | 'INVALID'
  | 'CONFLICT'
  | 'ERROR';

interface ConfirmEvent {
  readonly evt: 'booking_confirm';
  readonly outcome: ConfirmEventOutcome;
  readonly bookingId: string;
  readonly chargeCurrency: string;
  readonly sourceCurrency?: string;
  readonly alreadyConfirmed?: boolean;
  readonly fxOutcomeKind?: ConfirmFxOutcome['kind'];
  readonly provider?: 'STRIPE' | 'OXR';
  readonly errorReason?: string;
}

/**
 * Builds the structured event consumed by `BookingService` logging.
 * Pure (no side effects) so the unit tests can verify the shape
 * without spying on the Logger.
 */
function buildConfirmEvent(args: {
  readonly input: ConfirmBookingInput;
  readonly outcome: ConfirmBookingResult | undefined;
  readonly error: unknown;
  readonly sourceCurrency: string | undefined;
}): ConfirmEvent {
  const base = {
    evt: 'booking_confirm' as const,
    bookingId: args.input.bookingId,
    chargeCurrency: args.input.chargeCurrency,
    ...(args.sourceCurrency !== undefined
      ? { sourceCurrency: args.sourceCurrency }
      : {}),
  };

  if (args.error !== undefined) {
    return {
      ...base,
      outcome: classifyError(args.error),
      errorReason:
        args.error instanceof Error ? args.error.message : String(args.error),
    };
  }
  // The `finally` may run with both `outcome` and `error` undefined
  // only if a synchronous return slipped past every code path — that
  // is structurally impossible today, but we handle it defensively as
  // an ERROR rather than crash the logger.
  if (args.outcome === undefined) {
    return { ...base, outcome: 'ERROR', errorReason: 'unknown — no outcome' };
  }
  return {
    ...base,
    outcome: args.outcome.alreadyConfirmed ? 'ALREADY_CONFIRMED' : 'CONFIRMED',
    alreadyConfirmed: args.outcome.alreadyConfirmed,
    ...(args.outcome.fxOutcome !== undefined
      ? { fxOutcomeKind: args.outcome.fxOutcome.kind }
      : {}),
    ...(args.outcome.fxOutcome !== undefined &&
    'provider' in args.outcome.fxOutcome
      ? { provider: args.outcome.fxOutcome.provider }
      : {}),
  };
}

function classifyError(err: unknown): ConfirmEventOutcome {
  if (err instanceof BadRequestException) return 'INVALID';
  if (err instanceof NotFoundException) return 'NOT_FOUND';
  if (err instanceof ConflictException) return 'CONFLICT';
  return 'ERROR';
}

function decisionToLockInput(
  decision: Extract<
    BookingFxLockDecision,
    { kind: 'STRIPE_FX_QUOTE' | 'SNAPSHOT_REFERENCE' }
  >,
  bookingId: string,
): BookingFxLockInput {
  const base = {
    id: newUlid(),
    bookingId,
    appliedKind: 'CONFIRMATION' as const,
    lockKind: decision.kind,
    sourceCurrency: decision.sourceCurrency,
    chargeCurrency: decision.chargeCurrency,
    rate: decision.rate,
    sourceMinor: decision.sourceMinor,
    chargeMinor: decision.chargeMinor,
    provider: decision.provider,
  };
  if (decision.kind === 'STRIPE_FX_QUOTE') {
    return {
      ...base,
      providerQuoteId: decision.providerQuoteId,
      expiresAt: decision.expiresAt,
    };
  }
  return { ...base, rateSnapshotId: decision.rateSnapshotId };
}
