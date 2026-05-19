import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Pool } from '@bb/db';
import { PG_POOL } from '../database/database.module';
import { AuditService } from '../audit/audit.service';
import { DocumentContentRepository } from './document-content.repository';
import { DocumentStorage } from './document-storage';
import {
  DocumentRepository,
  isUniqueViolation,
  type IssuedDocumentRecord,
} from './document.repository';

/**
 * Booking Documents Foundation — Slice 1.
 *
 * Issues a backend-only, structured-JSON `BB_BOOKING_CONFIRMATION` for
 * a CONFIRMED booking. No PDF, no HTML, no email/delivery, no public
 * URL, no voucher, no tax invoice, no reseller branding. The async
 * document-issue worker is deferred — this is a synchronous internal
 * endpoint.
 *
 * Content is built **only** from immutable booking-time snapshots
 * pinned at CONFIRMED (Booking Truth Slice 2); the mutable live
 * supply / search tables are never read.
 *
 * Pipeline (one call to `issue`):
 *
 *   PRE-TRANSACTION (no DB tx held):
 *     1. Load the booking header (documents-owned SQL). 404 if absent.
 *     2. Refuse non-CONFIRMED bookings (422).
 *     3. Load pinned snapshots. Missing offer pin → 422 (fail safe).
 *     4. Replay fast-path: if a document already exists for
 *        (bookingId, BB_BOOKING_CONFIRMATION), return it
 *        `replayed: true` — no number, no blob, no audit.
 *     5. Build the structured JSON content; content-address + write
 *        the blob to object storage. A storage failure throws here,
 *        before any DB transaction — no document row, no number.
 *
 *   TRANSACTION (one short Postgres transaction; no network):
 *     6. BEGIN.
 *     7. Allocate the next monotonic number (atomic upsert).
 *     8. INSERT the ISSUED document row. A unique-violation race on
 *        (booking_id, document_type) rolls back and replays.
 *     9. `emitInTransaction(BOOKING_DOCUMENT_CREATED)`. Audit failure
 *        rolls back the document row and the number allocation.
 *    10. COMMIT.
 */
@Injectable()
export class BookingConfirmationService {
  private readonly logger = new Logger(BookingConfirmationService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(DocumentContentRepository)
    private readonly contentRepo: DocumentContentRepository,
    @Inject(DocumentRepository)
    private readonly documentRepo: DocumentRepository,
    @Inject(DocumentStorage)
    private readonly storage: DocumentStorage,
    @Inject(AuditService) private readonly auditService: AuditService,
  ) {}

  async issue(
    raw: unknown,
  ): Promise<{ document: DocumentView; replayed: boolean }> {
    const bookingId = parseBody(raw);

    const header = await this.contentRepo.loadBookingHeader(
      this.pool,
      bookingId,
    );
    if (!header) {
      throw new NotFoundException(`Booking not found: ${bookingId}`);
    }
    if (header.status !== 'CONFIRMED') {
      throw new UnprocessableEntityException(
        `Cannot issue ${DOCUMENT_TYPE} for booking ${bookingId}: ` +
          `status is '${header.status}', must be 'CONFIRMED'`,
      );
    }

    const offer = await this.contentRepo.loadPinnedOffer(
      this.pool,
      bookingId,
    );
    if (!offer) {
      throw new UnprocessableEntityException(
        `Cannot issue ${DOCUMENT_TYPE} for booking ${bookingId}: ` +
          `no pinned booking-time offer snapshot ` +
          `(booking truth was not pinned at confirm)`,
      );
    }

    const existing = await this.documentRepo.findByBookingAndType(
      this.pool,
      bookingId,
      DOCUMENT_TYPE,
    );
    if (existing) {
      this.logger.log({
        evt: 'booking_document_issue',
        outcome: 'REPLAYED',
        bookingId,
        documentId: existing.id,
      });
      return { document: toView(existing), replayed: true };
    }

    const [components, cancellation, taxFees] = await Promise.all([
      this.contentRepo.loadPinnedComponents(this.pool, bookingId),
      this.contentRepo.loadPinnedCancellationPolicy(this.pool, bookingId),
      this.contentRepo.loadPinnedTaxFees(this.pool, bookingId),
    ]);

    const content = {
      documentType: DOCUMENT_TYPE,
      contentSchemaVersion: CONTENT_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      booking: {
        id: header.id,
        reference: header.reference,
        tenantId: header.tenant_id,
        accountId: header.account_id,
        status: header.status,
        checkIn: header.check_in,
        checkOut: header.check_out,
        guest: {
          firstName: header.guest_first_name,
          lastName: header.guest_last_name,
          email: header.guest_email,
        },
        sellAmountMinorUnits: header.sell_amount_minor_units,
        sellCurrency: header.sell_currency,
        supplierRef: header.supplier_ref,
        supplierRawRef: header.supplier_raw_ref,
        supplierConfirmationRef: header.supplier_confirmation_ref,
        supplierBookingStatus: header.supplier_booking_status,
      },
      sourceOffer: {
        supplierId: offer.supplier_id,
        supplierHotelCode: offer.supplier_hotel_code,
        supplierRateKey: offer.supplier_rate_key,
        canonicalHotelId: offer.canonical_hotel_id,
        checkIn: offer.check_in,
        checkOut: offer.check_out,
        occupancyAdults: offer.occupancy_adults,
        supplierRoomCode: offer.supplier_room_code,
        supplierRateCode: offer.supplier_rate_code,
        supplierMealCode: offer.supplier_meal_code,
        totalAmountMinorUnits: offer.total_amount_minor_units,
        totalCurrency: offer.total_currency,
        rateBreakdownGranularity: offer.rate_breakdown_granularity,
      },
      priceComponents: components.map((c) => ({
        kind: c.component_kind,
        description: c.description,
        amountMinorUnits: c.amount_minor_units,
        currency: c.currency,
        appliesToNightDate: c.applies_to_night_date,
        appliesToPersonKind: c.applies_to_person_kind,
        inclusive: c.inclusive,
      })),
      cancellationPolicy: cancellation
        ? {
            refundable: cancellation.refundable,
            windows: cancellation.windows_jsonb,
            sourceVerbatimText: cancellation.source_verbatim_text,
            parsedWith: cancellation.parsed_with,
          }
        : null,
      taxesAndFees: taxFees.map((t) => ({
        kind: t.kind,
        description: t.description,
        amountMinorUnits: t.amount_minor_units,
        currency: t.currency,
        inclusive: t.inclusive,
        appliesToNightDate: t.applies_to_night_date,
      })),
    };

    // Blob first, BEFORE any DB tx (network). Content-addressed, so a
    // later rollback leaves at most a harmless orphan.
    const stored = await this.storage.putJson({
      tenantId: header.tenant_id,
      documentType: DOCUMENT_TYPE,
      content,
    });

    const now = new Date();
    const fiscalYear = now.getUTCFullYear();

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const seq = await this.documentRepo.allocateNumber(client, {
        tenantId: header.tenant_id,
        documentType: DOCUMENT_TYPE,
        scopeKey: SCOPE_KEY,
        fiscalYear,
        prefix: NUMBER_PREFIX,
      });
      const documentNumber = formatDocumentNumber(
        fiscalYear,
        seq.allocatedNumber,
      );

      let inserted: IssuedDocumentRecord;
      try {
        inserted = await this.documentRepo.insertIssued(client, {
          tenantId: header.tenant_id,
          bookingId,
          documentType: DOCUMENT_TYPE,
          documentNumber,
          objectStorageKey: stored.objectStorageKey,
          contentHash: stored.contentHash,
          contentSchemaVersion: CONTENT_SCHEMA_VERSION,
        });
      } catch (err) {
        if (isUniqueViolation(err, 'doc_booking_document_bk_type_uq')) {
          await client.query('ROLLBACK').catch(() => undefined);
          const winner = await this.documentRepo.findByBookingAndType(
            this.pool,
            bookingId,
            DOCUMENT_TYPE,
          );
          if (winner) {
            return { document: toView(winner), replayed: true };
          }
        }
        throw err;
      }

      await this.auditService.emitInTransaction(client, {
        category: 'APP',
        kind: 'BOOKING_DOCUMENT_CREATED',
        tenantId: header.tenant_id,
        targetId: bookingId,
        payload: {
          documentId: inserted.id,
          bookingId,
          tenantId: header.tenant_id,
          documentType: DOCUMENT_TYPE,
          documentNumber,
          status: 'ISSUED',
          contentHash: stored.contentHash,
          objectStorageKey: stored.objectStorageKey,
          sequenceId: seq.sequenceId,
          allocatedNumber: String(seq.allocatedNumber),
        },
      });

      await client.query('COMMIT');

      this.logger.log({
        evt: 'booking_document_issue',
        outcome: 'ISSUED',
        bookingId,
        documentId: inserted.id,
        documentNumber,
      });
      return { document: toView(inserted), replayed: false };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}

// ── Constants ──────────────────────────────────────────────────────────

const DOCUMENT_TYPE = 'BB_BOOKING_CONFIRMATION' as const;
/**
 * Bump when the structured-JSON content shape changes in a breaking
 * way. Old blobs keep their version; readers branch on it.
 */
const CONTENT_SCHEMA_VERSION = 1 as const;
const SCOPE_KEY = 'TENANT' as const;
const NUMBER_PREFIX = 'BB-CONF' as const;

/**
 * Document-number format (documented in ADR-016):
 *
 *   BB-CONF-<YYYY>-<NNNNN>
 *
 * `<YYYY>` is the UTC issue year (display/readability only — the
 * sequence is NOT reset per year). `<NNNNN>` is the monotonic
 * per-tenant counter, zero-padded to a minimum of 5 digits and
 * allowed to grow beyond that. Monotonic, not gapless.
 */
function formatDocumentNumber(year: number, n: number): string {
  return `${NUMBER_PREFIX}-${year}-${String(n).padStart(5, '0')}`;
}

// ── Response view ──────────────────────────────────────────────────────

export interface DocumentView {
  readonly id: string;
  readonly tenantId: string;
  readonly bookingId: string;
  readonly documentType: 'BB_BOOKING_CONFIRMATION';
  readonly documentNumber: string;
  readonly status: 'ISSUED';
  readonly objectStorageKey: string;
  readonly contentHash: string;
  readonly contentSchemaVersion: number;
  readonly issuedAt: string;
}

function toView(r: IssuedDocumentRecord): DocumentView {
  return {
    id: r.id,
    tenantId: r.tenantId,
    bookingId: r.bookingId,
    documentType: 'BB_BOOKING_CONFIRMATION',
    documentNumber: r.documentNumber,
    status: 'ISSUED',
    objectStorageKey: r.objectStorageKey,
    contentHash: r.contentHash,
    contentSchemaVersion: r.contentSchemaVersion,
    issuedAt: r.issuedAt,
  };
}

// ── Body validation ────────────────────────────────────────────────────

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function parseBody(raw: unknown): string {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new BadRequestException('Request body must be a JSON object');
  }
  const o = raw as Record<string, unknown>;
  const bookingId = o['bookingId'];
  if (typeof bookingId !== 'string' || !ULID_PATTERN.test(bookingId)) {
    throw new BadRequestException(
      'bookingId is required and must be a 26-character Crockford ULID',
    );
  }
  return bookingId;
}
