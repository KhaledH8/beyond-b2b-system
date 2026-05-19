import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Pool } from '@bb/db';
import { PG_POOL } from '../database/database.module';
import { AuditService } from '../audit/audit.service';
import { newUlid } from '../common/ulid';
import {
  BookingRepository,
  isUniqueViolation,
  type BookingIntakeRecord,
  type InsertInitiatedBookingInput,
} from './booking.repository';
import { generateBookingReference } from './booking-reference';

/**
 * Booking Intake — Slice 1 (booking-truth foundation).
 *
 * Creates an INITIATED `booking_booking` row from a selected priced
 * sourced offer, with a durable `BOOKING_CREATED` audit event written
 * in the SAME transaction as the insert. No money moves, no supplier
 * `book()` is called, no payment, no ledger, no documents, no
 * confirmation. This slice exists so the pre-existing
 * `POST /internal/bookings/:id/confirm` endpoint is reachable from
 * real data instead of being dead code.
 *
 * Pipeline (one call to `create`):
 *
 *   PRE-TRANSACTION:
 *     1. Validate + normalise the request (shape, pricing pinned,
 *        money-movement enums, ULID-ish ids, dates).
 *     2. Bookability gate: refuse a PROVISIONAL money-movement rate
 *        (mirrors `assertRateBookable` / ADR-020 — a rate whose
 *        collection/settlement/payment-cost model is unresolved must
 *        never become a booking).
 *     3. Idempotency fast-path: if (tenantId, idempotencyKey) already
 *        resolves to a booking, return it with `replayed: true`. No
 *        transaction, no second audit event.
 *
 *   TRANSACTION (one Postgres transaction):
 *     4. BEGIN.
 *     5. INSERT the INITIATED booking. Reference collisions
 *        (`booking_booking_ref_uq`) retry with a fresh reference.
 *        An idempotency-key race (`booking_booking_idem_uq`) rolls
 *        back, re-reads the winner, and returns it as a replay.
 *     6. `AuditService.emitInTransaction` writes BOOKING_CREATED on
 *        the same client. A failed audit insert propagates and rolls
 *        back the booking — an un-audited booking is never committed.
 *     7. COMMIT.
 */
@Injectable()
export class BookingIntakeService {
  private readonly logger = new Logger(BookingIntakeService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(BookingRepository)
    private readonly repository: BookingRepository,
    @Inject(AuditService) private readonly auditService: AuditService,
  ) {}

  async create(raw: unknown): Promise<{
    booking: BookingIntakeView;
    replayed: boolean;
  }> {
    const input = validateIntakeInput(raw);

    const existing = await this.repository.findByIdempotencyKey(
      this.pool,
      input.tenantId,
      input.idempotencyKey,
    );
    if (existing) {
      this.logger.log({
        evt: 'booking_intake',
        outcome: 'REPLAYED',
        bookingId: existing.id,
        tenantId: input.tenantId,
      });
      return { booking: toView(existing), replayed: true };
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      let created: BookingIntakeRecord | undefined;
      let lastErr: unknown;
      for (let attempt = 0; attempt < REFERENCE_RETRY_LIMIT; attempt++) {
        const insertInput: InsertInitiatedBookingInput = {
          id: newUlid(),
          tenantId: input.tenantId,
          accountId: input.accountId,
          canonicalHotelId: input.canonicalHotelId,
          reference: generateBookingReference(),
          checkIn: input.checkIn,
          checkOut: input.checkOut,
          guestDetails: {
            guest: input.guest,
            occupancy: input.occupancy,
          },
          moneyMovement: input.moneyMovement,
          sellAmountMinorUnits: input.sellAmountMinorUnits,
          sellCurrency: input.sellCurrency,
          sourceOfferSnapshotId: input.sourceOfferSnapshotId,
          idempotencyKey: input.idempotencyKey,
          supplierRef: input.supplier,
          supplierRawRef: input.supplierRawRef,
        };
        try {
          created = await this.repository.insertInitiated(
            client,
            insertInput,
          );
          break;
        } catch (err) {
          if (isUniqueViolation(err, 'booking_booking_idem_uq')) {
            // Concurrent intake with the same key won the race. Roll
            // back our empty work and return the committed winner.
            await client.query('ROLLBACK').catch(() => undefined);
            const winner = await this.repository.findByIdempotencyKey(
              this.pool,
              input.tenantId,
              input.idempotencyKey,
            );
            if (winner) {
              return { booking: toView(winner), replayed: true };
            }
            throw err;
          }
          if (isUniqueViolation(err, 'booking_booking_ref_uq')) {
            lastErr = err;
            continue; // regenerate reference, retry
          }
          throw err;
        }
      }

      if (!created) {
        throw new Error(
          `Could not allocate a unique booking reference after ` +
            `${REFERENCE_RETRY_LIMIT} attempts`,
          { cause: lastErr },
        );
      }

      await this.auditService.emitInTransaction(client, {
        category: 'APP',
        kind: 'BOOKING_CREATED',
        tenantId: created.tenantId,
        targetId: created.id,
        payload: {
          bookingId: created.id,
          tenantId: created.tenantId,
          accountId: created.accountId,
          bookingReference: created.reference,
          sourceOfferSnapshotId: created.sourceOfferSnapshotId,
          supplier: created.supplierRef ?? input.supplier,
          supplierRawRef: created.supplierRawRef ?? input.supplierRawRef,
          sellAmountMinorUnits: (
            created.sellAmountMinorUnits ?? input.sellAmountMinorUnits
          ).toString(),
          sellCurrency: created.sellCurrency ?? input.sellCurrency,
          status: 'INITIATED',
        },
      });

      await client.query('COMMIT');

      this.logger.log({
        evt: 'booking_intake',
        outcome: 'CREATED',
        bookingId: created.id,
        tenantId: created.tenantId,
      });
      return { booking: toView(created), replayed: false };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      this.logger.error({
        evt: 'booking_intake',
        outcome: 'ERROR',
        tenantId: input.tenantId,
        errorReason: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      client.release();
    }
  }
}

// ── Response view ──────────────────────────────────────────────────────

export interface BookingIntakeView {
  readonly id: string;
  readonly tenantId: string;
  readonly accountId: string;
  readonly reference: string;
  readonly status: 'INITIATED';
  readonly sourceOfferSnapshotId: string | null;
  readonly supplier: string;
  readonly supplierRawRef: string;
  readonly sellAmountMinorUnits: number;
  readonly sellCurrency: string;
  readonly checkIn: string;
  readonly checkOut: string;
  readonly createdAt: string;
}

function toView(r: BookingIntakeRecord): BookingIntakeView {
  return {
    id: r.id,
    tenantId: r.tenantId,
    accountId: r.accountId,
    reference: r.reference,
    status: 'INITIATED',
    sourceOfferSnapshotId: r.sourceOfferSnapshotId,
    supplier: r.supplierRef ?? '',
    supplierRawRef: r.supplierRawRef ?? '',
    sellAmountMinorUnits: Number(r.sellAmountMinorUnits ?? 0n),
    sellCurrency: r.sellCurrency ?? '',
    checkIn: r.checkIn,
    checkOut: r.checkOut,
    createdAt: r.createdAt,
  };
}

// ── Validation ─────────────────────────────────────────────────────────

const REFERENCE_RETRY_LIMIT = 5;
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

// Mirrors the booking-shell CHECK constraints. Validated here so an
// off-enum value yields a clean 400 instead of a Postgres 23514 → 500.
const COLLECTION_MODES = new Set([
  'BB_COLLECTS',
  'RESELLER_COLLECTS',
  'PROPERTY_COLLECT',
  'UPSTREAM_PLATFORM_COLLECT',
]);
const SETTLEMENT_MODES = new Set([
  'PREPAID_BALANCE',
  'POSTPAID_INVOICE',
  'COMMISSION_ONLY',
  'VCC_TO_PROPERTY',
  'DIRECT_PROPERTY_CHARGE',
]);
const COST_MODELS = new Set([
  'PLATFORM_CARD_FEE',
  'RESELLER_CARD_FEE',
  'PROPERTY_CARD_FEE',
  'UPSTREAM_NETTED',
  'BANK_TRANSFER_SETTLEMENT',
]);

interface ValidatedIntakeInput {
  readonly tenantId: string;
  readonly accountId: string;
  readonly canonicalHotelId: string;
  readonly sourceOfferSnapshotId: string | null;
  readonly supplier: string;
  readonly supplierRawRef: string;
  readonly checkIn: string;
  readonly checkOut: string;
  readonly occupancy: Readonly<Record<string, unknown>>;
  readonly guest: Readonly<Record<string, unknown>>;
  readonly sellAmountMinorUnits: bigint;
  readonly sellCurrency: string;
  readonly moneyMovement: {
    readonly collectionMode: string;
    readonly supplierSettlementMode: string;
    readonly paymentCostModel: string;
  };
  readonly idempotencyKey: string;
}

function validateIntakeInput(raw: unknown): ValidatedIntakeInput {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new BadRequestException('Request body must be a JSON object');
  }
  const o = raw as Record<string, unknown>;

  const tenantId = reqUlid(o, 'tenantId');
  const accountId = reqUlid(o, 'accountId');
  // Accept canonicalHotelId, falling back to hotelId for caller
  // convenience; both name the same canonical-hotel ULID.
  const hotelIdValue =
    o['canonicalHotelId'] !== undefined ? o['canonicalHotelId'] : o['hotelId'];
  const canonicalHotelId = reqUlid(
    { canonicalHotelId: hotelIdValue },
    'canonicalHotelId',
  );

  const sourceOfferSnapshotId = optUlid(o, 'sourceOfferSnapshotId');

  const supplier = reqStr(o, 'supplier', 64);
  const supplierRawRef = reqStr(o, 'supplierRawRef', 128);
  const idempotencyKey = reqStr(o, 'idempotencyKey', 255);

  const checkIn = reqDate(o, 'checkIn');
  const checkOut = reqDate(o, 'checkOut');
  if (checkOut <= checkIn) {
    throw new BadRequestException('checkOut must be after checkIn');
  }

  const occupancy = reqObject(o, 'occupancy');
  const guest = reqObject(o, 'guestDetails');

  // Pricing must be pinned before a booking can exist.
  const sellCurrency = o['sellCurrency'];
  const sellAmountRaw = o['sellAmountMinorUnits'];
  if (
    sellAmountRaw === undefined ||
    sellAmountRaw === null ||
    sellCurrency === undefined ||
    sellCurrency === null
  ) {
    throw new BadRequestException(
      'Cannot create booking: pricing not pinned ' +
        '(sellAmountMinorUnits and sellCurrency are required)',
    );
  }
  const sellAmountMinorUnits = toPositiveBigInt(
    sellAmountRaw,
    'sellAmountMinorUnits',
  );
  if (typeof sellCurrency !== 'string' || !CURRENCY_PATTERN.test(sellCurrency)) {
    throw new BadRequestException(
      'sellCurrency must be a 3-letter uppercase ISO 4217 code',
    );
  }

  const mm = reqObject(o, 'moneyMovement');
  const collectionMode = enumStr(mm, 'collectionMode', COLLECTION_MODES);
  const supplierSettlementMode = enumStr(
    mm,
    'supplierSettlementMode',
    SETTLEMENT_MODES,
  );
  const paymentCostModel = enumStr(mm, 'paymentCostModel', COST_MODELS);

  // Bookability gate (ADR-020). A PROVISIONAL rate must never become a
  // booking. `moneyMovementProvenance` is optional in the request;
  // when present, PROVISIONAL is hard-rejected. An explicit
  // `isBookable: false` is also refused.
  const provenance = o['moneyMovementProvenance'];
  if (provenance === 'PROVISIONAL') {
    throw new UnprocessableEntityException(
      'Refusing intake: rate moneyMovementProvenance is PROVISIONAL. ' +
        'The supplier commercial agreement must be resolved before ' +
        'this rate can be booked (ADR-020).',
    );
  }
  if (o['isBookable'] === false) {
    throw new UnprocessableEntityException(
      'Refusing intake: selected rate is marked not bookable',
    );
  }

  return {
    tenantId,
    accountId,
    canonicalHotelId,
    sourceOfferSnapshotId,
    supplier,
    supplierRawRef,
    checkIn,
    checkOut,
    occupancy,
    guest,
    sellAmountMinorUnits,
    sellCurrency,
    moneyMovement: {
      collectionMode,
      supplierSettlementMode,
      paymentCostModel,
    },
    idempotencyKey,
  };
}

function reqUlid(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (typeof v !== 'string' || !ULID_PATTERN.test(v)) {
    throw new BadRequestException(
      `${key} is required and must be a 26-character Crockford-base32 ULID`,
    );
  }
  return v;
}

function optUlid(o: Record<string, unknown>, key: string): string | null {
  const v = o[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || !ULID_PATTERN.test(v)) {
    throw new BadRequestException(
      `${key}, when present, must be a 26-character Crockford-base32 ULID`,
    );
  }
  return v;
}

function reqStr(
  o: Record<string, unknown>,
  key: string,
  max: number,
): string {
  const v = o[key];
  if (typeof v !== 'string' || v.length === 0 || v.length > max) {
    throw new BadRequestException(
      `${key} is required and must be a non-empty string of at most ${max} chars`,
    );
  }
  return v;
}

function reqDate(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (typeof v !== 'string' || !ISO_DATE_PATTERN.test(v)) {
    throw new BadRequestException(`${key} is required and must be YYYY-MM-DD`);
  }
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) {
    throw new BadRequestException(`${key} is not a valid calendar date`);
  }
  return v;
}

function reqObject(
  o: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const v = o[key];
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new BadRequestException(`${key} is required and must be an object`);
  }
  return v as Record<string, unknown>;
}

function enumStr(
  o: Record<string, unknown>,
  key: string,
  allowed: ReadonlySet<string>,
): string {
  const v = o[key];
  if (typeof v !== 'string' || !allowed.has(v)) {
    throw new BadRequestException(
      `${key} must be one of: ${[...allowed].join(', ')}`,
    );
  }
  return v;
}

function toPositiveBigInt(v: unknown, key: string): bigint {
  let n: bigint;
  if (typeof v === 'number') {
    if (!Number.isInteger(v)) {
      throw new BadRequestException(`${key} must be an integer`);
    }
    n = BigInt(v);
  } else if (typeof v === 'string' && /^\d+$/.test(v)) {
    n = BigInt(v);
  } else {
    throw new BadRequestException(
      `${key} must be a non-negative integer (minor units)`,
    );
  }
  if (n <= 0n) {
    throw new BadRequestException(`${key} must be greater than zero`);
  }
  return n;
}
