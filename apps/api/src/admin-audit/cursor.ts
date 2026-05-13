/**
 * Cursor encoding for the audit-event LIST API (ADR-028 D9).
 *
 * Format: base64 of a small JSON object `{ o: string, i: string }` where
 *   - `o` is the ISO-8601 `occurred_at` of the row at the page boundary
 *   - `i` is the 26-char ULID of the same row
 *
 * Cursors are opaque to clients. Stability under inserts is the only
 * design property — offset pagination would shift if new rows are
 * inserted between requests; `(occurred_at, id)` does not.
 *
 * Invalid cursors decode to `null`; the service then surfaces a 400.
 * We never throw from the decode function itself — invalid input is a
 * value, not an exceptional condition, on this boundary.
 */

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export interface CursorValue {
  readonly occurredAt: Date;
  readonly id: string;
}

export function encodeCursor(occurredAt: string, id: string): string {
  const json = JSON.stringify({ o: occurredAt, i: id });
  return Buffer.from(json, 'utf8').toString('base64');
}

export function decodeCursor(raw: string): CursorValue | null {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, 'base64').toString('utf8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const v = parsed as Record<string, unknown>;
  if (typeof v['o'] !== 'string' || typeof v['i'] !== 'string') return null;
  if (!ULID_PATTERN.test(v['i'])) return null;
  const occurredAt = new Date(v['o']);
  if (Number.isNaN(occurredAt.getTime())) return null;
  return { occurredAt, id: v['i'] };
}
