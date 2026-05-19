import { randomInt } from 'crypto';

/**
 * Human-readable booking reference: `BB-YYYY-NNNNN`.
 *
 *   BB      fixed platform prefix (intentionally NOT tenant-branded —
 *           white-label reference schemes are a later, deliberate
 *           configuration concern, not Slice 1).
 *   YYYY    UTC calendar year of creation.
 *   NNNNN   five random digits.
 *
 * This is deliberately NOT a gapless sequence. Gapless sequential
 * numbering in this platform is reserved for legal tax documents
 * (ADR-016), allocated only at document issue. A booking reference is
 * a lookup handle, not a fiscal artefact, so a random suffix plus the
 * existing `booking_booking_ref_uq (tenant_id, reference)` unique
 * index plus caller-side retry is sufficient and avoids a hot counter
 * row. Uniqueness is enforced by the DB, not by this function.
 */
export function generateBookingReference(now: Date = new Date()): string {
  const year = now.getUTCFullYear();
  const suffix = randomInt(0, 100_000).toString().padStart(5, '0');
  return `BB-${year}-${suffix}`;
}
