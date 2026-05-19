import { Injectable } from '@nestjs/common';
import type { Queryable } from '../database/queryable';
import { newUlid } from '../common/ulid';

/**
 * Repository for the two `doc_` tables (ADR-016, Booking Documents
 * Foundation Slice 1). Parameterised SQL only.
 */

export interface IssuedDocumentRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly bookingId: string;
  readonly documentType: string;
  readonly documentNumber: string;
  readonly status: string;
  readonly objectStorageKey: string;
  readonly contentHash: string;
  readonly contentSchemaVersion: number;
  readonly issuedAt: string;
}

interface DocumentDbRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly booking_id: string;
  readonly document_type: string;
  readonly document_number: string;
  readonly status: string;
  readonly object_storage_key: string;
  readonly content_hash: string;
  readonly content_schema_version: number;
  readonly issued_at: string | Date;
}

function toRecord(row: DocumentDbRow): IssuedDocumentRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    bookingId: row.booking_id,
    documentType: row.document_type,
    documentNumber: row.document_number,
    status: row.status,
    objectStorageKey: row.object_storage_key,
    contentHash: row.content_hash,
    contentSchemaVersion: row.content_schema_version,
    issuedAt:
      row.issued_at instanceof Date
        ? row.issued_at.toISOString()
        : row.issued_at,
  };
}

const DOC_RETURNING = `
  id, tenant_id, booking_id, document_type, document_number, status,
  object_storage_key, content_hash, content_schema_version, issued_at
`;

@Injectable()
export class DocumentRepository {
  /**
   * Replay lookup: the existing issued document for a
   * (booking_id, document_type) pair, or `undefined`. Backed by the
   * `doc_booking_document_bk_type_uq` UNIQUE constraint, so a replayed
   * issue resolves to the original document instead of allocating a
   * new number or writing a new blob.
   */
  async findByBookingAndType(
    q: Queryable,
    bookingId: string,
    documentType: string,
  ): Promise<IssuedDocumentRecord | undefined> {
    const { rows } = await q.query<DocumentDbRow>(
      `SELECT ${DOC_RETURNING}
         FROM doc_booking_document
        WHERE booking_id = $1 AND document_type = $2`,
      [bookingId, documentType],
    );
    return rows.length > 0 ? toRecord(rows[0]!) : undefined;
  }

  /**
   * Atomically allocates the next number for
   * (tenant_id, document_type, scope_key). Race-free: the first writer
   * inserts the sequence row at 1; concurrent writers hit
   * `doc_number_sequence_scope_uq` and take the `ON CONFLICT DO UPDATE`
   * branch, which row-locks and increments under that lock. No
   * read-then-write window.
   *
   * MONOTONIC, explicitly NOT gapless: this runs inside the issuing
   * transaction, so a rolled-back issue rolls the increment back too —
   * but a committed-then-superseded number is never reused. Acceptable
   * for a commercial (non-legal) document.
   */
  async allocateNumber(
    q: Queryable,
    args: {
      readonly tenantId: string;
      readonly documentType: string;
      readonly scopeKey: string;
      readonly fiscalYear: number | null;
      readonly prefix: string;
    },
  ): Promise<{ sequenceId: string; allocatedNumber: number }> {
    const { rows } = await q.query<{
      id: string;
      last_issued_number: string;
    }>(
      `INSERT INTO doc_number_sequence (
         id, tenant_id, document_type, scope_key,
         fiscal_year, last_issued_number, prefix
       ) VALUES ($1, $2, $3, $4, $5, 1, $6)
       ON CONFLICT (tenant_id, document_type, scope_key)
       DO UPDATE SET
         last_issued_number = doc_number_sequence.last_issued_number + 1,
         updated_at = now()
       RETURNING id, last_issued_number`,
      [
        newUlid(),
        args.tenantId,
        args.documentType,
        args.scopeKey,
        args.fiscalYear,
        args.prefix,
      ],
    );
    const row = rows[0]!;
    return {
      sequenceId: row.id,
      allocatedNumber: Number(row.last_issued_number),
    };
  }

  /**
   * Inserts the ISSUED document row. The
   * `doc_booking_document_bk_type_uq` UNIQUE constraint is the hard
   * backstop against a double-issue race; a unique violation surfaces
   * to the caller (SQLSTATE 23505) which rolls back and replays.
   */
  async insertIssued(
    q: Queryable,
    args: {
      readonly tenantId: string;
      readonly bookingId: string;
      readonly documentType: string;
      readonly documentNumber: string;
      readonly objectStorageKey: string;
      readonly contentHash: string;
      readonly contentSchemaVersion: number;
    },
  ): Promise<IssuedDocumentRecord> {
    const { rows } = await q.query<DocumentDbRow>(
      `INSERT INTO doc_booking_document (
         id, tenant_id, booking_id, document_type, document_number,
         status, object_storage_key, content_hash, content_schema_version
       ) VALUES ($1, $2, $3, $4, $5, 'ISSUED', $6, $7, $8)
       RETURNING ${DOC_RETURNING}`,
      [
        newUlid(),
        args.tenantId,
        args.bookingId,
        args.documentType,
        args.documentNumber,
        args.objectStorageKey,
        args.contentHash,
        args.contentSchemaVersion,
      ],
    );
    return toRecord(rows[0]!);
  }
}

/** Postgres unique-violation SQLSTATE (shared with booking intake). */
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
